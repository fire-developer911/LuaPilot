const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  pluginSessionId: {
    type: String,
    required: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expireAfterSeconds: 0 }, // MongoDB TTL auto-cleanup
  },
  connected: {
    type: Boolean,
    default: false,
  },
  lastSeenAt: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

sessionSchema.index({ pluginSessionId: 1 });
sessionSchema.index({ code: 1, expiresAt: 1 });

module.exports = mongoose.model('Session', sessionSchema);
