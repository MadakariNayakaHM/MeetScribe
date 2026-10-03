import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import multer from 'multer';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import meetingRoutes from './routes/meetings.js';
import mediaRoutes from './routes/media.js';
import settingsRoutes from './routes/settings.js';
import { initTranscription, whisperStatus } from './services/transcription.js';

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '5mb' }));
app.use(morgan(config.isProd ? 'combined' : 'dev'));

app.get('/api/health', (_req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
app.get('/api/config', (_req, res) => res.json({ whisper: whisperStatus() }));
app.use('/api/auth', authRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// In production, serve the built React app from the same origin.
if (fs.existsSync(config.clientDist)) {
  app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(config.clientDist, 'index.html'));
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Internal server error';
  if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    if (err.code === 'LIMIT_FILE_SIZE') message = `File too large (max ${config.maxUploadMb} MB)`;
  } else if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) {
    status = 400;
  } else if (err.type === 'entity.too.large') {
    status = 413;
  }
  if (status >= 500) {
    console.error(err);
    if (config.isProd) message = 'Internal server error';
  }
  res.status(status).json({ error: message });
});

await mongoose.connect(config.mongoUri);
console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
app.listen(config.port, () => console.log(`API listening on http://localhost:${config.port}`));
await initTranscription();
