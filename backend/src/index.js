// src/index.js — NetWatch Backend entry point
// Phase 1: Added /api/host-mappings route; IST timestamps in startup logs.
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt       = require('bcryptjs');
const db           = require('./db');
const { log }      = require('./services/appLog');
const { startSchedulers } = require('./services/monitoringService');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const corsOrigin = process.env.CORS_ORIGIN || true;
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get('/healthz', (req, res) => res.json({
  status:   'ok',
  service:  'netwatch-backend',
  timezone: 'Asia/Kolkata (IST)',
}));

app.use('/api/auth',          require('./controllers/authController'));
app.use('/api/tasks',         require('./controllers/tasksController'));
app.use('/api/logs',          require('./controllers/logsController'));
app.use('/api/backup',        require('./controllers/backupController'));
app.use('/api/host-mappings', require('./controllers/hostMappingsController'));

app.use((err, req, res, _next) => {
  console.error('[Express Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

function nowIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-') + ' IST';
}

async function startup() {
  const rawPass = process.env.ADMIN_PASS;
  if (!rawPass) {
    console.error('[STARTUP] ADMIN_PASS environment variable is required');
    process.exit(1);
  }
  if (!process.env.ADMIN_USER) {
    console.error('[STARTUP] ADMIN_USER environment variable is required');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('[STARTUP] JWT_SECRET must be at least 32 characters');
    process.exit(1);
  }

  process.env.ADMIN_PASS_HASH = await bcrypt.hash(rawPass, 12);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[NetWatch] Backend running on port ${PORT} — ${nowIST()}`);
    log('INFO', 'ADMIN', 'system', null,
      `NetWatch started on port ${PORT} — monitor host: ${process.env.MONITOR_HOST || 'not-set'} — ${nowIST()}`,
      `Node ${process.version}`);
  });

  startSchedulers();
}

startup().catch(err => {
  console.error('[STARTUP FAILED]', err.message);
  process.exit(1);
});