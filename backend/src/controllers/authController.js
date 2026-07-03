// src/controllers/authController.js
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { signToken, requireAuth } = require('../middleware/auth');
const { log, audit } = require('../services/appLog');

const router = Router();

// Simple in-memory rate limiter: 5 attempts per IP per minute
const attempts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxAttempts = 5;

  const record = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - record.windowStart > windowMs) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count++;
  attempts.set(ip, record);

  if (record.count > maxAttempts) {
    log('WARN', 'AUTH', 'system', null, `Rate limit exceeded for IP ${ip}`, null);
    return res.status(429).json({ error: 'Too many login attempts. Please wait a minute.' });
  }
  next();
}

// POST /api/auth/login
router.post('/login', rateLimit, async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.socket.remoteAddress;

  const expectedUser = process.env.ADMIN_USER;
  const expectedHash = process.env.ADMIN_PASS_HASH; // bcrypt hash set on startup

  if (!username || !password || username !== expectedUser) {
    log('WARN', 'AUTH', username || 'unknown', null,
      `Login failed — invalid credentials from IP ${ip}`, null);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, expectedHash);
  if (!valid) {
    log('WARN', 'AUTH', username, null,
      `Login failed — wrong password from IP ${ip}`, null);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ username });
  const hours = parseInt(process.env.SESSION_HOURS || '8');

  res.cookie('netwatch_token', token, {
    httpOnly: true,
    sameSite: 'lax',   // 'strict' breaks cross-origin dev; adjust for prod
    maxAge: hours * 3600 * 1000,
  });

  log('INFO', 'AUTH', username, null, `Login successful from IP ${ip}`, null);
  audit(username, 'LOGIN', `Successful login from ${ip}`);
  res.json({ ok: true, username });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('netwatch_token');
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

module.exports = router;
