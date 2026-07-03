// src/controllers/authController.js
// Phase 1: Audit log actor is the actual username; AUTH category used consistently.

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { signToken, requireAuth } = require('../middleware/auth');
const { log, audit } = require('../services/appLog');

const router = Router();

// Simple in-memory rate limiter: 5 attempts per IP per minute
const attempts = new Map();
function rateLimit(req, res, next) {
  const ip       = req.ip || req.socket.remoteAddress;
  const now      = Date.now();
  const windowMs = 60 * 1000;
  const maxAtt   = 5;

  const record = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - record.windowStart > windowMs) {
    record.count       = 0;
    record.windowStart = now;
  }
  record.count++;
  attempts.set(ip, record);

  if (record.count > maxAtt) {
    log('WARN', 'AUTH', 'system', null, `Rate limit exceeded for IP ${ip}`, null);
    return res.status(429).json({ error: 'Too many login attempts. Please wait a minute.' });
  }
  next();
}

// POST /api/auth/login
router.post('/login', rateLimit, async (req, res) => {
  const { username, password } = req.body;
  const ip           = req.ip || req.socket.remoteAddress;
  const expectedUser = process.env.ADMIN_USER;
  const expectedHash = process.env.ADMIN_PASS_HASH;

  if (!username || !password || username !== expectedUser) {
    const actor = username || 'unknown';
    log('WARN', 'AUTH', actor, null,
      `Login failed — invalid credentials from IP ${ip}`, null);
    audit(actor, 'LOGIN_FAILED', `Invalid credentials from ${ip}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, expectedHash);
  if (!valid) {
    log('WARN', 'AUTH', username, null,
      `Login failed — wrong password from IP ${ip}`, null);
    audit(username, 'LOGIN_FAILED', `Wrong password from ${ip}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ username });
  const hours = parseInt(process.env.SESSION_HOURS || '8');

  res.cookie('netwatch_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: hours * 3600 * 1000,
  });

  log('INFO', 'AUTH', username, null, `Login successful from IP ${ip}`, null);
  audit(username, 'LOGIN_SUCCESS', `Successful login from ${ip}`);
  res.json({ ok: true, username });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // Try to get the username from token for the audit log
  let username = 'admin';
  try {
    const jwt   = require('jsonwebtoken');
    const token = req.cookies?.netwatch_token;
    if (token) {
      const payload = jwt.decode(token);
      if (payload?.username) username = payload.username;
    }
  } catch {}

  res.clearCookie('netwatch_token');
  log('INFO', 'AUTH', username, null, 'Logout', null);
  audit(username, 'LOGOUT', 'Session ended');
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

module.exports = router;