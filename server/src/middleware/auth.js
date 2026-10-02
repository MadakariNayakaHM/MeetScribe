import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../utils/http.js';

export const signToken = (userId) =>
  jwt.sign({ sub: String(userId), typ: 'access' }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

// Short-lived, meeting-scoped token so <audio src> can stream without an Authorization header.
export const signMediaToken = (userId, meetingId) =>
  jwt.sign({ sub: String(userId), mid: String(meetingId), typ: 'media' }, config.jwtSecret, { expiresIn: '6h' });

export const verifyToken = (token, typ) => {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.typ !== typ) throw new Error('wrong token type');
    return payload;
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
};

export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Authentication required');
  req.userId = verifyToken(token, 'access').sub;
  next();
}
