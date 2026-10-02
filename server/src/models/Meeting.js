import mongoose from 'mongoose';

const segmentSchema = new mongoose.Schema({
  startMs: { type: Number, required: true, min: 0 },
  endMs: { type: Number, required: true, min: 0 },
  text: { type: String, required: true, maxlength: 10000 },
  speaker: { type: String, default: 'Speaker 1', trim: true, maxlength: 60 },
  highlighted: { type: Boolean, default: false },
});

const meetingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, default: '', maxlength: 50000 },
    tags: { type: [{ type: String, trim: true, lowercase: true, maxlength: 40 }], default: [] },
    language: { type: String, default: 'en-US', maxlength: 20 },
    status: { type: String, enum: ['recording', 'completed'], default: 'recording' },
    startedAt: { type: Date, default: Date.now },
    endedAt: Date,
    durationMs: { type: Number, default: 0, min: 0 },
    audio: {
      filename: String,
      mimeType: String,
      size: Number,
    },
    // Optional stereo recording: left = local microphone, right = shared tab (other participants).
    tracks: {
      filename: String,
      mimeType: String,
      size: Number,
    },
    transcription: {
      source: { type: String, enum: ['live', 'whisper'], default: 'live' },
      status: { type: String, enum: ['none', 'queued', 'processing', 'done', 'failed'], default: 'none' },
      progress: { type: Number, default: 0 },
      model: String,
      error: String,
      queuedAt: Date,
      startedAt: Date,
      completedAt: Date,
    },
    segments: { type: [segmentSchema], default: [] },
    // Reserved for future AI features (summary, action items, ...).
    summary: {
      text: String,
      generatedAt: Date,
      provider: String,
    },
  },
  { timestamps: true },
);

meetingSchema.index({ user: 1, createdAt: -1 });
meetingSchema.index({ 'transcription.status': 1, 'transcription.queuedAt': 1 });

meetingSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    if (ret.audio) {
      ret.hasAudio = Boolean(ret.audio.filename);
      delete ret.audio.filename;
    }
    ret.hasTracks = Boolean(ret.tracks?.filename);
    delete ret.tracks;
    return ret;
  },
});

export const Meeting = mongoose.model('Meeting', meetingSchema);
