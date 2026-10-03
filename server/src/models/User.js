import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true },
    // OpenAI model used for summaries and Q&A. The key is encrypted and never sent to clients.
    ai: {
      model: { type: String, trim: true, maxlength: 200 },
      apiKeyEnc: { type: String, select: false },
      keyHint: String,
    },
  },
  { timestamps: true },
);

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    if (ret.ai) delete ret.ai.apiKeyEnc;
    delete ret.__v;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
