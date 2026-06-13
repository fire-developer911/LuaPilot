require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/session');
const promptRoutes = require('./routes/prompt');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Connect to MongoDB ───────────────────────────────────────────────────────
connectDB();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (Roblox Studio plugin, curl, etc.)
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL || 'http://localhost:3000',
    ];
    if (allowed.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    // Allow any localhost during development
    if (origin.match(/^https?:\/\/localhost(:\d+)?$/)) {
      return callback(null, true);
    }
    return callback(null, true); // Allow all origins for now (plugin has no origin)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Handle preflight
app.options('*', cors());

app.use(express.json({ limit: '5mb' })); // Allow large project structures
app.use(express.urlencoded({ extended: true }));

// Global rate limiter - generous to avoid 429 cascading from retries
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
  skip: (req) => {
    // Skip SSE endpoint and health check from rate limiting
    return req.path === '/dashboard/results' || req.path === '/health';
  },
});
app.use(globalLimiter);

// ─── Request logging (simple) ─────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/health') {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/', sessionRoutes);
app.use('/', promptRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Roblox AI Backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
