/**
 * OpenRouter API Service with Key Rotation
 * 
 * Reads multiple API keys from OPENROUTER_API_KEY env var (comma-separated).
 * Rotates to the next key on 429/rate-limit errors.
 * Retries up to N times across different keys before giving up.
 */

const DEFAULT_MODEL = 'qwen/qwen3-coder:free';
const MAX_RETRIES = 8; // Try up to 8 different keys before giving up

class OpenRouterService {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
    this.model = DEFAULT_MODEL;
    this._loadKeys();
  }

  _loadKeys() {
    const raw = process.env.OPENROUTER_API_KEY || '';
    this.keys = raw
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (this.keys.length === 0) {
      console.warn('[OpenRouter] No API keys found in OPENROUTER_API_KEY env var');
    } else {
      console.log(`[OpenRouter] Loaded ${this.keys.length} API key(s)`);
    }

    // Allow model override via env
    if (process.env.OPENROUTER_MODEL) {
      this.model = process.env.OPENROUTER_MODEL;
    }
  }

  /**
   * Call OpenRouter chat completions API with automatic key rotation.
   * @param {string} systemPrompt - System message
   * @param {string} userPrompt - User message
   * @returns {{ content: string, keyUsed: number }} or throws
   */
  async generate(systemPrompt, userPrompt) {
    if (this.keys.length === 0) {
      throw new Error('No OpenRouter API keys configured');
    }

    let lastError = null;

    for (let attempt = 0; attempt < Math.min(MAX_RETRIES, this.keys.length); attempt++) {
      const keyIndex = (this.currentIndex + attempt) % this.keys.length;
      const apiKey = this.keys[keyIndex];

      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://roblox-ai-assistant.app',
            'X-Title': 'Roblox AI Assistant',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 8192,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        });

        const data = await response.json();

        // Handle rate limiting / provider errors
        if (response.status === 429) {
          console.warn(`[OpenRouter] Key ${keyIndex + 1}/${this.keys.length} rate-limited (429). Rotating...`);
          this.currentIndex = (keyIndex + 1) % this.keys.length;
          lastError = { status: 429, message: data?.error?.message || 'Rate limited by provider' };
          continue; // Try next key
        }

        if (response.status >= 400) {
          const errMsg = data?.error?.message || `HTTP ${response.status}`;
          console.warn(`[OpenRouter] Key ${keyIndex + 1}/${this.keys.length} error (${response.status}): ${errMsg}`);
          
          // For 401/403 (bad key), rotate immediately
          if (response.status === 401 || response.status === 403) {
            this.currentIndex = (keyIndex + 1) % this.keys.length;
            lastError = { status: response.status, message: errMsg };
            continue;
          }

          // For 502/503/504 (provider down), rotate and try next
          if (response.status >= 500) {
            this.currentIndex = (keyIndex + 1) % this.keys.length;
            lastError = { status: response.status, message: errMsg };
            continue;
          }

          // Other client errors — don't rotate, just fail
          throw new Error(`API error ${response.status}: ${errMsg}`);
        }

        // Success
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('Empty response from AI');
        }

        // Update current index to the working key for next time
        this.currentIndex = keyIndex;

        console.log(`[OpenRouter] Success with key ${keyIndex + 1}/${this.keys.length}`);
        return { content, keyUsed: keyIndex };

      } catch (err) {
        if (err.message?.startsWith('API error') || err.message === 'Empty response from AI') {
          throw err; // Re-throw non-retryable errors
        }
        // Network errors, etc.
        console.warn(`[OpenRouter] Key ${keyIndex + 1}/${this.keys.length} request failed: ${err.message}`);
        lastError = { status: 0, message: err.message };
        this.currentIndex = (keyIndex + 1) % this.keys.length;
        continue;
      }
    }

    // All keys exhausted
    const errMsg = lastError?.message || 'All API keys exhausted';
    const errStatus = lastError?.status || 429;
    const error = new Error(`API error ${errStatus}: ${errMsg}`);
    error.status = errStatus;
    error.isApiError = true;
    throw error;
  }
}

// Singleton
module.exports = new OpenRouterService();
