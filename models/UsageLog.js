const mongoose = require('mongoose');

const usageLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  promptId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prompt',
    required: true,
  },
  cost: {
    type: Number,
    required: true,
    min: 1,
  },
  sessionId: {
    type: String,
    required: true,
  },
  model: {
    type: String,
    default: 'openrouter',
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

usageLogSchema.index({ userId: 1, timestamp: -1 });

module.exports = mongoose.model('UsageLog', usageLogSchema);
