import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../utils/http.js';
import { encrypt } from '../utils/crypto.js';
import { DEFAULT_MODEL, chatCompletion, listModels, loadAiSettings } from '../services/ai.js';

const router = Router();
router.use(requireAuth);

const testLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

async function aiView(userId) {
  const user = await User.findById(userId).select('+ai.apiKeyEnc');
  if (!user) throw new HttpError(401, 'Account no longer exists');
  return {
    model: user.ai?.model || '',
    defaultModel: DEFAULT_MODEL,
    hasKey: Boolean(user.ai?.apiKeyEnc),
    keyHint: user.ai?.apiKeyEnc ? user.ai.keyHint : '',
  };
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function readBody(b = {}) {
  const apiKey = str(b.apiKey, 500);
  if (apiKey && !/^\S+$/.test(apiKey)) throw new HttpError(400, 'The API key must not contain spaces');
  return { model: str(b.model, 200), apiKey };
}

router.get('/ai', async (req, res) => {
  res.json(await aiView(req.userId));
});

// Body: { model, apiKey? }. An empty apiKey keeps the saved one.
router.put('/ai', async (req, res) => {
  const { model, apiKey } = readBody(req.body);
  const $set = { 'ai.model': model };
  if (apiKey) {
    $set['ai.apiKeyEnc'] = encrypt(apiKey);
    $set['ai.keyHint'] = apiKey.slice(-4);
  }
  await User.updateOne({ _id: req.userId }, { $set });
  res.json(await aiView(req.userId));
});

router.delete('/ai/key', async (req, res) => {
  await User.updateOne({ _id: req.userId }, { $unset: { 'ai.apiKeyEnc': 1, 'ai.keyHint': 1 } });
  res.json(await aiView(req.userId));
});

// Sends a tiny prompt with the given (or saved) key and model, without saving anything.
router.post('/ai/test', testLimiter, async (req, res) => {
  const settings = await loadAiSettings(req.userId, readBody(req.body));
  const started = Date.now();
  const reply = await chatCompletion(settings, [{ role: 'user', content: 'Reply with just the word: OK' }]);
  res.json({ ok: true, model: settings.model, reply: reply.slice(0, 100), ms: Date.now() - started });
});

router.get('/ai/models', async (req, res) => {
  const settings = await loadAiSettings(req.userId).catch(() => null);
  res.json({ models: settings ? await listModels(settings.apiKey) : [] });
});

export default router;
