// src/controllers/logsController.js
// Phase 1 changes:
//   - Logs reworked into 3 clear categories:
//       TASK  — monitoring checks, fault/recovery/manual/email
//       ADMIN — task CRUD, toggles, backup/import/export, settings
//       AUTH  — login/logout/auth events (from audit_logs)
//   - All timestamps returned as IST in API responses
//   - Log retention: 15 days active; end-of-day archive files
//   - Download APIs: today / last 7d / last 15d, by category
//   - LOG_ARCHIVE_DIR configurable from environment / 3_run.sh
//   - Audit logs served under /api/logs/audit (removed from Settings)
//   - /api/logs/health kept intact

const { Router } = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendTestEmail } = require('../mail/mailService');
const { log } = require('../services/appLog');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const router = Router();

// ── Constants ──────────────────────────────────────────────────────────────

const LOG_RETENTION_DAYS = 15;   // active log retention in DB
const PAGE_SIZE          = 25;   // rows per page in UI

// Trim limits — keep active DB small; archiving handles long-term storage
const APP_LOG_MAX    = 5000;
const APP_LOG_TRIM   = 500;
const AUDIT_LOG_MAX  = 2000;
const AUDIT_LOG_TRIM = 200;

const LOG_ARCHIVE_DIR = process.env.LOG_ARCHIVE_DIR
  || (db.LOG_ARCHIVE_DIR)
  || path.join(process.env.DATA_DIR || './data', 'log-archives');

// ── IST helper ─────────────────────────────────────────────────────────────

function toIST(utcStr) {
  if (!utcStr) return null;
  try {
    return new Date(utcStr).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).replace(/\//g, '-') + ' IST';
  } catch {
    return utcStr;
  }
}

function convertLogsToIST(logs) {
  return logs.map(row => ({
    ...row,
    created_at_ist: toIST(row.created_at),
    created_at:     row.created_at, // keep UTC for programmatic use
  }));
}

// ── Trim helpers (called after every insert) ───────────────────────────────

function trimAppLogs() {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM app_logs').get().c;
  if (cnt > APP_LOG_MAX) {
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

module.exports.trimAppLogs   = trimAppLogs;
module.exports.trimAuditLogs = trimAuditLogs;

// ── Category mapping ───────────────────────────────────────────────────────
// Frontend can filter by logical group: TASK_LOGS, ADMIN_LOGS, AUTH_LOGS
// These map to app_logs.category values (and audit_logs for AUTH).

const TASK_CATEGORIES  = ['TASK', 'MONITORING', 'EMAIL'];
const ADMIN_CATEGORIES = ['ADMIN', 'BACKUP', 'SYSTEM'];
// AUTH comes from audit_logs table

// ── Date helpers ───────────────────────────────────────────────────────────

/**
 * Get UTC cutoff string for N days ago at IST midnight (00:00 IST = 18:30 UTC previous day)
 */
function istDaysAgoCutoff(days) {
  const now = new Date();
  // IST offset is +5:30 = 330 minutes
  const istNow = new Date(now.getTime() + 330 * 60 * 1000);
  // Go back N days in IST
  const istTarget = new Date(istNow);
  istTarget.setDate(istTarget.getDate() - days);
  istTarget.setHours(0, 0, 0, 0);
  // Convert back to UTC
  const utcTarget = new Date(istTarget.getTime() - 330 * 60 * 1000);
  return utcTarget.toISOString();
}

/**
 * Get IST date string for today: YYYY-MM-DD
 */
function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

// ── GET /api/logs/app ──────────────────────────────────────────────────────
// Query params: level, category, task_name, group (TASK_LOGS|ADMIN_LOGS), page

router.get('/app', requireAuth, (req, res) => {
  const {
    level, category, task_name, group,
    page = 0,
  } = req.query;

  const offset = parseInt(page) * PAGE_SIZE;
  const where  = [];
  const params = [];

  // group overrides category
  if (group === 'TASK_LOGS') {
    where.push(`category IN (${TASK_CATEGORIES.map(() => '?').join(',')})`);
    params.push(...TASK_CATEGORIES);
  } else if (group === 'ADMIN_LOGS') {
    where.push(`category IN (${ADMIN_CATEGORIES.map(() => '?').join(',')})`);
    params.push(...ADMIN_CATEGORIES);
  } else {
    if (level    && level    !== 'ALL') { where.push('level=?');          params.push(level); }
    if (category && category !== 'ALL') { where.push('category=?');       params.push(category); }
  }
  if (task_name) { where.push('task_name LIKE ?'); params.push(`%${task_name}%`); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT * FROM app_logs ${whereClause}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, PAGE_SIZE, offset);

  const total = db.prepare(`
    SELECT COUNT(*) as cnt FROM app_logs ${whereClause}
  `).get(...params).cnt;

  res.json({
    logs:       convertLogsToIST(rows),
    total,
    page:       parseInt(page),
    pageSize:   PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
});

// ── GET /api/logs/audit ────────────────────────────────────────────────────
// AUTH / audit log endpoint (previously only in Settings; now also here)

router.get('/audit', requireAuth, (req, res) => {
  const { page = 0 } = req.query;
  const offset = parseInt(page) * PAGE_SIZE;

  const rows = db.prepare(`
    SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(PAGE_SIZE, offset);

  const total = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get().cnt;

  res.json({
    logs:       convertLogsToIST(rows),
    total,
    page:       parseInt(page),
    pageSize:   PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
});

// ── GET /api/logs/download ─────────────────────────────────────────────────
// Query params:
//   range    : today | 7d | 15d
//   category : TASK_LOGS | ADMIN_LOGS | AUTH_LOGS | ALL
//   format   : json | csv (default json)

router.get('/download', requireAuth, (req, res) => {
  const { range = 'today', category = 'ALL', format = 'json' } = req.query;

  let cutoff;
  switch (range) {
    case '7d':    cutoff = istDaysAgoCutoff(7);  break;
    case '15d':   cutoff = istDaysAgoCutoff(15); break;
    case 'today': default:
      cutoff = istDaysAgoCutoff(1);
      break;
  }

  let appLogs   = [];
  let auditLogs = [];

  if (category === 'AUTH_LOGS' || category === 'ALL') {
    auditLogs = db.prepare(
      'SELECT * FROM audit_logs WHERE created_at >= ? ORDER BY created_at DESC'
    ).all(cutoff);
  }

  if (category !== 'AUTH_LOGS') {
    const where  = ['created_at >= ?'];
    const params = [cutoff];

    if (category === 'TASK_LOGS') {
      where.push(`category IN (${TASK_CATEGORIES.map(() => '?').join(',')})`);
      params.push(...TASK_CATEGORIES);
    } else if (category === 'ADMIN_LOGS') {
      where.push(`category IN (${ADMIN_CATEGORIES.map(() => '?').join(',')})`);
      params.push(...ADMIN_CATEGORIES);
    }

    appLogs = db.prepare(
      `SELECT * FROM app_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC`
    ).all(...params);
  }

  const rangeLabel    = range === 'today' ? 'today' : `last-${range}`;
  const categoryLabel = category.toLowerCase().replace('_', '-');
  const dateStr       = todayIST();
  const filename      = `netwatch-logs-${rangeLabel}-${categoryLabel}-${dateStr}`;

  if (format === 'csv') {
    const lines = ['timestamp_utc,timestamp_ist,level,category,actor,task_name,message,detail'];

    for (const r of appLogs) {
      lines.push([
        r.created_at, toIST(r.created_at),
        r.level, r.category, r.actor || '',
        (r.task_name || '').replace(/,/g, ';'),
        (r.message   || '').replace(/,/g, ';').replace(/\n/g, ' '),
        (r.detail    || '').replace(/,/g, ';').replace(/\n/g, ' '),
      ].join(','));
    }

    for (const r of auditLogs) {
      lines.push([
        r.created_at, toIST(r.created_at),
        'INFO', 'AUTH', r.actor || '',
        '', // no task_name for audit
        (r.action || '').replace(/,/g, ';'),
        (r.detail  || '').replace(/,/g, ';').replace(/\n/g, ' '),
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(lines.join('\n'));
  }

  // Default: JSON
  const payload = {
    generated_at_ist: toIST(new Date().toISOString()),
    range,
    category,
    app_logs:   convertLogsToIST(appLogs),
    audit_logs: convertLogsToIST(auditLogs),
    totals: {
      app_logs:   appLogs.length,
      audit_logs: auditLogs.length,
    },
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
  res.json(payload);

  log('INFO', 'ADMIN', req.user.username, null,
    `Logs downloaded: range=${range} category=${category} format=${format}`, null);
});

// ── GET /api/logs/archives ─────────────────────────────────────────────────
// List available archive files

router.get('/archives', requireAuth, (req, res) => {
  const archives = db.prepare(
    'SELECT * FROM log_archives ORDER BY archive_date DESC LIMIT 50'
  ).all();

  res.json({
    archives: archives.map(a => ({
      ...a,
      created_at_ist: toIST(a.created_at),
    })),
    archive_dir: LOG_ARCHIVE_DIR,
  });
});

// ── GET /api/logs/archives/:id/download ───────────────────────────────────

router.get('/archives/:id/download', requireAuth, (req, res) => {
  const archive = db.prepare('SELECT * FROM log_archives WHERE id=?').get(req.params.id);
  if (!archive) return res.status(404).json({ error: 'Archive not found' });

  if (!fs.existsSync(archive.filepath)) {
    return res.status(404).json({ error: 'Archive file not found on disk' });
  }

  log('INFO', 'ADMIN', req.user.username, null,
    `Archive downloaded: ${archive.filename}`, null);

  res.download(archive.filepath, archive.filename);
});

// ── POST /api/logs/test-email ──────────────────────────────────────────────

router.post('/test-email', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });

  try {
    await sendTestEmail(to);
    log('INFO', 'TASK', req.user.username, null, `Test mail sent to ${to}`, null);
    res.json({ ok: true, message: `Test mail sent to ${to}` });
  } catch (err) {
    log('ERROR', 'TASK', req.user.username, null, `Test mail failed: ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/logs/health ───────────────────────────────────────────────────
// Kept intact from original

router.get('/health', requireAuth, (req, res) => {
  const { execSync } = require('child_process');

  const activeTasks   = db.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE deleted_at IS NULL').get().cnt;
  const faultTasks    = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status='FAULT' AND deleted_at IS NULL").get().cnt;
  const openIncidents = db.prepare('SELECT COUNT(*) as cnt FROM incident_state').get().cnt;
  const appLogCount   = db.prepare('SELECT COUNT(*) as cnt FROM app_logs').get().cnt;
  const auditLogCount = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get().cnt;
  const archiveCount  = db.prepare('SELECT COUNT(*) as cnt FROM log_archives').get().cnt;
  const dbSize        = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get();

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

  const archiveDirExists = fs.existsSync(LOG_ARCHIVE_DIR);

  res.json({
    status:           'ok',
    activeTasks,
    faultTasks,
    openIncidents,
    dbSizeKb:         Math.round((dbSize?.size || 0) / 1024),
    uptime:           Math.floor(process.uptime()),
    nodeVersion:      process.version,
    monitorHost:      process.env.MONITOR_HOST || 'not-set',
    timezone:         'Asia/Kolkata (IST)',
    mail: {
      binary:     mailBin || 'not found',
      binaryOk:   mailOk,
      postfix:    postfixStatus,
      relayHost:  process.env.POSTFIX_RELAY || 'host-gateway:25',
      fromName:   process.env.MAIL_FROM_NAME  || 'NetWatch Monitor',
      fromEmail:  process.env.MAIL_FROM_EMAIL || `alerts@${process.env.MONITOR_HOST || 'netwatch'}.local`,
    },
    logs: {
      appLogCount,
      appLogMax:     APP_LOG_MAX,
      auditLogCount,
      auditLogMax:   AUDIT_LOG_MAX,
      archiveCount,
      archiveDir:    LOG_ARCHIVE_DIR,
      archiveDirOk:  archiveDirExists,
      retentionDays: LOG_RETENTION_DAYS,
    },
  });
});

// ── Archive function (called by scheduler + can be triggered manually) ─────

async function archiveLogs() {
  if (!fs.existsSync(LOG_ARCHIVE_DIR)) {
    fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });
  }

  const today   = todayIST();
  const cutoff  = istDaysAgoCutoff(0); // start of today in UTC

  // Archive each category separately
  const archiveSets = [
    { category: 'TASK_LOGS',  categories: TASK_CATEGORIES },
    { category: 'ADMIN_LOGS', categories: ADMIN_CATEGORIES },
    { category: 'AUTH_LOGS',  categories: null },
    { category: 'ALL',        categories: null },
  ];

  for (const set of archiveSets) {
    let appLogs   = [];
    let auditLogs = [];

    if (set.category === 'AUTH_LOGS') {
      auditLogs = db.prepare(
        'SELECT * FROM audit_logs WHERE created_at >= ? ORDER BY created_at ASC'
      ).all(cutoff);
    } else if (set.category === 'ALL') {
      appLogs   = db.prepare('SELECT * FROM app_logs WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff);
      auditLogs = db.prepare('SELECT * FROM audit_logs WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff);
    } else {
      const placeholders = set.categories.map(() => '?').join(',');
      appLogs = db.prepare(
        `SELECT * FROM app_logs WHERE created_at >= ? AND category IN (${placeholders}) ORDER BY created_at ASC`
      ).all(cutoff, ...set.categories);
    }

    if (appLogs.length === 0 && auditLogs.length === 0) continue;

    const filename = `netwatch-logs-${today}-${set.category.toLowerCase().replace('_', '-')}.json`;
    const filepath = path.join(LOG_ARCHIVE_DIR, filename);

    const content = JSON.stringify({
      archive_date_ist: today,
      category: set.category,
      generated_at_ist: toIST(new Date().toISOString()),
      app_logs:   convertLogsToIST(appLogs),
      audit_logs: convertLogsToIST(auditLogs),
    }, null, 2);

    fs.writeFileSync(filepath, content, 'utf8');
    const sizeBytes = fs.statSync(filepath).size;

    // Check if this archive already recorded for today
    const existing = db.prepare(
      'SELECT id FROM log_archives WHERE archive_date=? AND category=?'
    ).get(today, set.category);

    if (existing) {
      db.prepare('UPDATE log_archives SET filename=?, filepath=?, size_bytes=?, created_at=datetime(\'now\') WHERE id=?')
        .run(filename, filepath, sizeBytes, existing.id);
    } else {
      db.prepare(`
        INSERT INTO log_archives (id, archive_date, filename, filepath, category, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), today, filename, filepath, set.category, sizeBytes);
    }
  }

  // Prune logs older than retention window from DB
  const pruneCutoff = istDaysAgoCutoff(LOG_RETENTION_DAYS);
  const pruned1 = db.prepare('DELETE FROM app_logs WHERE created_at < ?').run(pruneCutoff);
  const pruned2 = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(pruneCutoff);

  log('INFO', 'SYSTEM', 'scheduler', null,
    `Log archive completed for ${today}: pruned ${pruned1.changes} app_logs, ${pruned2.changes} audit_logs`, null);
}

module.exports.archiveLogs = archiveLogs;
module.exports = Object.assign(router, {
  trimAppLogs,
  trimAuditLogs,
  archiveLogs,
});