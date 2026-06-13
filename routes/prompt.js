const express = require('express');
const rateLimit = require('express-rate-limit');
const Session = require('../models/Session');
const Prompt = require('../models/Prompt');
const UsageLog = require('../models/UsageLog');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const openrouter = require('../services/openrouter');

const router = express.Router();

// In-memory SSE client map: userId -> res
const sseClients = new Map();

const promptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many prompts. Slow down.' },
});

// Calculate credit cost based on prompt length / complexity
function calculateCreditCost(prompt) {
  const words = prompt.trim().split(/\s+/).length;
  if (words > 100) return 3;
  return 1;
}

// POST /send-prompt
// Web app sends a prompt to the connected plugin
router.post('/send-prompt', authMiddleware, promptLimiter, async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    if (prompt.length > 4000) {
      return res.status(400).json({ error: 'Prompt too long (max 4000 chars)' });
    }

    // Find active connected session for this user
    const session = await Session.findOne({
      userId: req.user._id,
      connected: true,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!session) {
      return res.status(404).json({
        error: 'No active plugin session. Open Roblox Studio and connect using the plugin.',
      });
    }

    // Check credits
    const creditCost = calculateCreditCost(prompt);
    const freshUser = await User.findById(req.user._id);
    if (freshUser.credits < creditCost) {
      return res.status(402).json({
        error: `Not enough credits. You have ${freshUser.credits} credit(s), this request costs ${creditCost}.`,
        credits: freshUser.credits,
        required: creditCost,
      });
    }

    // Store prompt in DB
    const newPrompt = await Prompt.create({
      sessionId: session.pluginSessionId,
      userId: req.user._id,
      prompt: prompt.trim(),
      status: 'pending',
      creditsUsed: creditCost,
    });

    res.json({
      success: true,
      promptId: newPrompt._id,
      creditCost,
      creditsRemaining: freshUser.credits, // Not yet deducted; deducted on submit
      message: 'Prompt queued. Plugin will receive it shortly.',
    });
  } catch (err) {
    console.error('Send prompt error:', err);
    res.status(500).json({ error: 'Failed to queue prompt' });
  }
});

// POST /ai/generate
// Plugin sends project context + prompt, backend calls OpenRouter with key rotation
router.post('/ai/generate', async (req, res) => {
  try {
    const { pluginSessionId, systemPrompt, userPrompt } = req.body;

    if (!pluginSessionId || !systemPrompt || !userPrompt) {
      return res.status(400).json({ error: 'pluginSessionId, systemPrompt, and userPrompt are required' });
    }

    // Verify session exists
    const session = await Session.findOne({
      pluginSessionId,
      expiresAt: { $gt: new Date() },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    // Call OpenRouter with key rotation
    const { content } = await openrouter.generate(systemPrompt, userPrompt);

    res.json({ content });
  } catch (err) {
    console.error('AI generate error:', err.message);
    const status = err.status || 500;
    const isApiError = err.isApiError || false;
    res.status(status).json({
      error: err.message,
      isApiError,
    });
  }
});

// GET /poll?pluginSessionId=xxx
// Plugin polls for the latest pending prompt
router.get('/poll', async (req, res) => {
  try {
    const { pluginSessionId } = req.query;

    if (!pluginSessionId || typeof pluginSessionId !== 'string') {
      return res.status(400).json({ error: 'pluginSessionId is required' });
    }

    // Verify session exists and isn't expired
    const session = await Session.findOne({
      pluginSessionId,
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
      return res.json({ prompt: null, sessionValid: false });
    }

    // Keep session alive: extend expiry on every successful poll
    session.lastSeenAt = new Date();
    session.expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await session.save();

    // Get the oldest pending prompt for this session
    const pendingPrompt = await Prompt.findOne({
      sessionId: pluginSessionId,
      status: 'pending',
    }).sort({ createdAt: 1 });

    if (!pendingPrompt) {
      return res.json({
        prompt: null,
        sessionValid: true,
        connected: session.connected,
      });
    }

    // Mark as processing so it won't be returned twice
    pendingPrompt.status = 'processing';
    await pendingPrompt.save();

    res.json({
      prompt: {
        id: pendingPrompt._id,
        text: pendingPrompt.prompt,
        sessionId: pendingPrompt.sessionId,
      },
      sessionValid: true,
      connected: session.connected,
    });
  } catch (err) {
    console.error('Poll error:', err);
    res.status(500).json({ error: 'Poll failed' });
  }
});

// POST /submit-result
// Plugin submits the AI patch result after processing
router.post('/submit-result', async (req, res) => {
  try {
    const { pluginSessionId, promptId, result, success, error: pluginError, logs: pluginLogs, apiError } = req.body;

    if (!pluginSessionId || !promptId) {
      return res.status(400).json({ error: 'pluginSessionId and promptId are required' });
    }

    // Validate session
    const session = await Session.findOne({ pluginSessionId });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Keep session alive on submit too
    session.lastSeenAt = new Date();
    session.expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await session.save();

    // Find and update the prompt
    const prompt = await Prompt.findById(promptId);
    if (!prompt) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    if (prompt.sessionId !== pluginSessionId) {
      return res.status(403).json({ error: 'Session mismatch' });
    }

    prompt.status = success ? 'processed' : 'failed';
    prompt.result = result || null;
    prompt.logs = pluginLogs || [];
    prompt.processedAt = new Date();
    await prompt.save();

    // Deduct credits ONLY if not an API error (429, provider down, etc.)
    // API errors are not the user's fault — they shouldn't be charged
    let creditsRemaining = null;
    const shouldDeductCredits = !apiError;

    if (shouldDeductCredits && session.userId) {
      const user = await User.findById(session.userId);
      if (user) {
        user.credits = Math.max(0, user.credits - prompt.creditsUsed);
        await user.save();
        creditsRemaining = user.credits;

        // Log usage
        await UsageLog.create({
          userId: session.userId,
          promptId: prompt._id,
          cost: prompt.creditsUsed,
          sessionId: pluginSessionId,
        });
      }
    } else if (session.userId) {
      // API error — fetch current credits without deducting
      const user = await User.findById(session.userId);
      if (user) {
        creditsRemaining = user.credits;
      }
    }

    // ALWAYS push SSE update (both success and failure)
    if (session.userId) {
      const clientRes = sseClients.get(String(session.userId));
      if (clientRes) {
        const payload = JSON.stringify({
          type: 'result',
          promptId: prompt._id,
          result,
          success,
          error: pluginError || null,
          creditsRemaining,
          logs: pluginLogs || [],
        });
        clientRes.write(`data: ${payload}\n\n`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Submit result error:', err);
    res.status(500).json({ error: 'Failed to submit result' });
  }
});

// GET /dashboard/results — SSE stream for live result updates
router.get('/dashboard/results', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.flushHeaders();

  const userId = String(req.user._id);
  sseClients.set(userId, res);

  // Send a heartbeat every 25 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(userId);
  });
});

// GET /prompts/history — get last 20 prompts for user
router.get('/prompts/history', authMiddleware, async (req, res) => {
  try {
    const session = await Session.findOne({
      userId: req.user._id,
      connected: true,
    }).sort({ createdAt: -1 });

    const filter = session
      ? { userId: req.user._id, sessionId: session.pluginSessionId }
      : { userId: req.user._id };

    const prompts = await Prompt.find(filter)
      .sort({ createdAt: -1 })
      .limit(20)
      .select('-__v');

    res.json({ prompts });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /prompts/check — check if any pending/processing prompts have completed
// Used as a fallback when SSE events are missed
router.get('/prompts/check', authMiddleware, async (req, res) => {
  try {
    // Find all prompts that are processed/failed but might not have been
    // delivered to the frontend (SSE missed)
    const { ids } = req.query; // comma-separated list of promptIds to check

    if (!ids) {
      return res.json({ updates: [] });
    }

    const idList = String(ids).split(',').filter(Boolean);
    if (idList.length === 0) {
      return res.json({ updates: [] });
    }

    const prompts = await Prompt.find({
      _id: { $in: idList },
      userId: req.user._id,
      status: { $in: ['processed', 'failed'] },
    }).select('-__v');

    const updates = prompts.map((p) => ({
      promptId: p._id,
      status: p.status,
      result: p.result,
      error: p.result?.error || null,
      logs: p.logs || [],
      creditsUsed: p.creditsUsed,
      processedAt: p.processedAt,
    }));

    // Also fetch fresh credits
    const user = await User.findById(req.user._id).select('credits');

    res.json({
      updates,
      creditsRemaining: user ? user.credits : undefined,
    });
  } catch (err) {
    console.error('Check prompts error:', err);
    res.status(500).json({ error: 'Failed to check prompts' });
  }
});

module.exports = router;
