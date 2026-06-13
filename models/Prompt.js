const mongoose = require('mongoose');

const promptSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  prompt: {
    type: String,
    required: true,
    maxlength: 4000,
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'processed', 'failed'],
    default: 'pending',
    index: true,
  },
  result: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  logs: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
  },
  creditsUsed: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  processedAt: {
    type: Date,
    default: null,
  },
});

promptSchema.index({ sessionId: 1, status: 1 });
promptSchema.index({ sessionId: 1, createdAt: -1 });

module.exports = mongoose.model('Prompt', promptSchema);
