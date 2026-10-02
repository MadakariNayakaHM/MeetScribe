import { Router } from 'express';
import path from 'node:path';
import mongoose from 'mongoose';
import { Meeting } from '../models/Meeting.js';
import { verifyToken } from '../middleware/auth.js';
import { HttpError } from '../utils/http.js';
import { config } from '../config.js';

const router = Router();

// Streams a meeting's audio. Auth via a meeting-scoped media token in the query string,
// since <audio> elements cannot send an Authorization header. Supports HTTP Range for seeking.
router.get('/:id', async (req, res) => {
  const payload = verifyToken(String(req.query.token || ''), 'media');
  if (payload.mid !== req.params.id || !mongoose.isValidObjectId(req.params.id)) {
    throw new HttpError(403, 'Token does not match this meeting');
  }
  const meeting = await Meeting.findOne({ _id: req.params.id, user: payload.sub }, { audio: 1, title: 1 });
  if (!meeting?.audio?.filename) throw new HttpError(404, 'Audio not found');

  const file = path.join(config.uploadDir, meeting.audio.filename);
  const options = { headers: { 'Content-Type': meeting.audio.mimeType, 'Cache-Control': 'private, max-age=3600' } };
  if (req.query.download) {
    const ext = path.extname(meeting.audio.filename);
    const name = (meeting.title || 'meeting').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'meeting';
    return res.download(file, `${name}${ext}`, options);
  }
  res.sendFile(file, options);
});

export default router;
