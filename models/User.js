const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
  },
  passwordHash: {
    type: String,
    required: true,
  },
  credits: {
    type: Number,
    default: 100,
    min: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.index({ email: 1 });

module.exports = mongoose.model('User', userSchema);
