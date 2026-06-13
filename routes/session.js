const express = require('express');
const rateLimit = require('express-rate-limit');
const Session = require('../models/Session');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const pluginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests from plugin' },
});

// Generate a random 6-digit code (not starting with 0)
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// POST /register-session
// Called by the Roblox plugin when it starts or refreshes its code
router.post('/register-session', pluginLimiter, async (req, res) => {
  try {
    const { pluginSessionId, code } = req.body;

    if (!pluginSessionId || typeof pluginSessionId !== 'string') {
      return res.status(400).json({ error: 'pluginSessionId is required' });
    }

    if (pluginSessionId.length > 128) {
      return res.status(400).json({ error: 'pluginSessionId too long' });
    }

    // Check if there's an existing connected session for this plugin
    const existingSession = await Session.findOne({
      pluginSessionId,
      connected: true,
      expiresAt: { $gt: new Date() },
    });

    if (existingSession) {
      // Session is connected — just extend the expiry, keep everything else
      existingSession.expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      existingSession.lastSeenAt = new Date();
      await existingSession.save();

      return res.json({
        success: true,
        code: existingSession.code,
        expiresAt: existingSession.expiresAt,
        preserved: true,
      });
    }

    // No active connected session — clean up old ones and create fresh
    await Session.deleteMany({ pluginSessionId });

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const newCode = code || generateCode();

    // Ensure code is unique (retry if collision)
    let finalCode = newCode;
    let attempts = 0;
    while (attempts < 5) {
      const conflict = await Session.findOne({ code: finalCode });
      if (!conflict) break;
      finalCode = generateCode();
      attempts++;
    }

    const session = await Session.create({
      code: finalCode,
      pluginSessionId,
      expiresAt,
      connected: false,
      userId: null,
    });

    res.json({
      success: true,
      code: session.code,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error('Register session error:', err);
    res.status(500).json({ error: 'Failed to register session' });
  }
});

// POST /connect
// Called by the web app when user enters the 6-digit code
router.post('/connect', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code || !/^\d{6}$/.test(String(code))) {
      return res.status(400).json({ error: 'A valid 6-digit code is required' });
    }

    const session = await Session.findOne({
      code: String(code),
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
      return res.status(404).json({ error: 'Code not found or expired. Check your plugin.' });
    }

    // Link this session to the authenticated user
    session.userId = req.user._id;
    session.connected = true;
    session.lastSeenAt = new Date();
    await session.save();

    res.json({
      success: true,
      message: 'Connected to plugin session',
      pluginSessionId: session.pluginSessionId,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error('Connect error:', err);
    res.status(500).json({ error: 'Connection failed' });
  }
});

// GET /session/status
// Web app polls to get current session connection status
router.get('/session/status', authMiddleware, async (req, res) => {
  try {
    const session = await Session.findOne({
      userId: req.user._id,
      expiresAt: { $gt: new Date() },
      connected: true,
    }).sort({ createdAt: -1 });

    if (!session) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      pluginSessionId: session.pluginSessionId,
      expiresAt: session.expiresAt,
      code: session.code,
    });
  } catch (err) {
    console.error('Session status error:', err);
    res.status(500).json({ error: 'Failed to get session status' });
  }
});

module.exports = router;
