// src/controllers/logsController.js
const { Router } = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendTestEmail } = require('../mail/mailService');
const { log } = require('../services/appLog');

const router = Router();

// ── Log limits ────────────────────────────────────────────────────────────────
const APP_LOG_MAX    = 300;  // keep this many app_logs total
const APP_LOG_TRIM   = 100;  // delete oldest N when over limit
const AUDIT_LOG_MAX  = 150;  // keep this many audit_logs total
const AUDIT_LOG_TRIM = 50;   // delete oldest N when over limit
const PAGE_SIZE      = 20;   // rows per page in UI

// ── Trim helpers (called after every insert) ──────────────────────────────────

function trimAppLogs() {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM app_logs').get().c;
  if (cnt > APP_LOG_MAX) {
    // Delete the oldest APP_LOG_TRIM rows
    db.prepare(`
      DELETE FROM app_logs WHERE id IN (
        SELECT id FROM app_logs ORDER BY created_at ASC LIMIT ?
      )
    `).run(APP_LOG_TRIM);
  }
}

function trimAuditLogs() {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM audit_logs').get().c;
  if (cnt > AUDIT_LOG_MAX) {
    db.prepare(`
      DELETE FROM audit_logs WHERE id IN (
        SELECT id FROM audit_logs ORDER BY created_at ASC LIMIT ?
      )
    `).run(AUDIT_LOG_TRIM);
  }
}

// Export so appLog.js can call trim after each insert
module.exports.trimAppLogs  = trimAppLogs;
module.exports.trimAuditLogs = trimAuditLogs;

// ── GET /api/logs/app ─────────────────────────────────────────────────────────

router.get('/app', requireAuth, (req, res) => {
  const {
    level, category, task_name,
    page = 0,             // 0-based page
  } = req.query;

  const offset = parseInt(page) * PAGE_SIZE;
  const where  = [];
  const params = [];

  if (level    && level    !== 'ALL') { where.push('level=?');           params.push(level); }
  if (category && category !== 'ALL') { where.push('category=?');        params.push(category); }
  if (task_name)                      { where.push('task_name LIKE ?');   params.push(`%${task_name}%`); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT * FROM app_logs ${whereClause}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, PAGE_SIZE, offset);

  const total = db.prepare(`
    SELECT COUNT(*) as cnt FROM app_logs ${whereClause}
  `).get(...params).cnt;

  res.json({
    logs:      rows,
    total,
    page:      parseInt(page),
    pageSize:  PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
    limits:    { max: APP_LOG_MAX, trimBy: APP_LOG_TRIM },
  });
});

// ── GET /api/logs/audit ───────────────────────────────────────────────────────

router.get('/audit', requireAuth, (req, res) => {
  const { page = 0 } = req.query;
  const offset = parseInt(page) * 10;   // audit shows 10 per page in settings panel

  const rows = db.prepare(`
    SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 10 OFFSET ?
  `).all(offset);

  const total = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get().cnt;

  res.json({
    logs:      rows,
    total,
    page:      parseInt(page),
    totalPages: Math.ceil(total / 10),
    limits:    { max: AUDIT_LOG_MAX, trimBy: AUDIT_LOG_TRIM },
  });
});

// ── POST /api/logs/test-email ─────────────────────────────────────────────────

router.post('/test-email', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });

  try {
    await sendTestEmail(to);
    log('INFO', 'EMAIL', req.user.username, null, `Test mail sent to ${to}`, null);
    res.json({ ok: true, message: `Test mail sent to ${to}` });
  } catch (err) {
    log('ERROR', 'EMAIL', req.user.username, null, `Test mail failed: ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/logs/health ──────────────────────────────────────────────────────

router.get('/health', requireAuth, (req, res) => {
  const { execSync } = require('child_process');

  const activeTasks   = db.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE deleted_at IS NULL').get().cnt;
  const faultTasks    = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status='FAULT' AND deleted_at IS NULL").get().cnt;
  const openIncidents = db.prepare('SELECT COUNT(*) as cnt FROM incident_state').get().cnt;
  const appLogCount   = db.prepare('SELECT COUNT(*) as cnt FROM app_logs').get().cnt;
  const auditLogCount = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get().cnt;
  const dbSize        = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get();

  // Detect mail binary inside the container/host
  let mailBin  = null;
  let mailOk   = false;
  for (const b of ['mailx', 'mail', 's-nail', '/usr/bin/mail', '/bin/mail']) {
    try {
      const p = execSync(`which ${b} 2>/dev/null || (test -x ${b} && echo ${b})`, {
        stdio: 'pipe', shell: true,
      }).toString().trim();
      if (p) { mailBin = p; mailOk = true; break; }
    } catch {}
  }

  // Detect postfix
  let postfixStatus = 'unknown';
  try {
    execSync('postfix status 2>/dev/null', { stdio: 'pipe' });
    postfixStatus = 'running';
  } catch {
    try {
      execSync('service postfix status 2>/dev/null', { stdio: 'pipe' });
      postfixStatus = 'running';
    } catch {
      postfixStatus = 'not running';
    }
  }

  res.json({
    status:       'ok',
    activeTasks,
    faultTasks,
    openIncidents,
    dbSizeKb:     Math.round((dbSize?.size || 0) / 1024),
    uptime:       Math.floor(process.uptime()),
    nodeVersion:  process.version,
    monitorHost:  process.env.MONITOR_HOST || 'not-set',
    mail: {
      binary:        mailBin  || 'not found',
      binaryOk:      mailOk,
      postfix:       postfixStatus,
      relayHost:     process.env.POSTFIX_RELAY || 'host-gateway:25',
      fromName:      process.env.MAIL_FROM_NAME  || 'NetWatch Monitor',
      fromEmail:     process.env.MAIL_FROM_EMAIL || `alerts@${process.env.MONITOR_HOST || 'netwatch'}.local`,
    },
    logs: {
      appLogCount,
      appLogMax:    APP_LOG_MAX,
      auditLogCount,
      auditLogMax:  AUDIT_LOG_MAX,
    },
  });
});

module.exports = router;
