import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.JWT_SECRET && isProd) {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  isProd,
  port: Number(process.env.PORT || 5050),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27018/meetscribe',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR || 'uploads'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 500),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  clientDist: path.resolve(root, '../client/dist'),
  whisper: {
    enabled: process.env.WHISPER_ENABLED !== 'false',
    autoTranscribe: process.env.WHISPER_AUTO !== 'false',
    python: path.resolve(root, process.env.WHISPER_PYTHON || 'worker/.venv/bin/python'),
    script: path.resolve(root, 'worker/transcribe.py'),
    model: process.env.WHISPER_MODEL || 'small',
    device: process.env.WHISPER_DEVICE || 'auto',
    computeType: process.env.WHISPER_COMPUTE_TYPE || 'int8',
    threads: Number(process.env.WHISPER_THREADS || 0),
    modelDir: path.resolve(root, process.env.WHISPER_MODEL_DIR || 'worker/models'),
  },
};
