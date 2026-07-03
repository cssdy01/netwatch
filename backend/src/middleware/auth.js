// src/middleware/auth.js — JWT authentication middleware
const jwt = require('jsonwebtoken');

const JWT_SECRET = () => process.env.JWT_SECRET || 'dev-secret-change-this';

function requireAuth(req, res, next) {
  const token = req.cookies?.netwatch_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET());
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function signToken(payload) {
  const hours = parseInt(process.env.SESSION_HOURS || '8');
  return jwt.sign(payload, JWT_SECRET(), { expiresIn: `${hours}h` });
}

module.exports = { requireAuth, signToken };
