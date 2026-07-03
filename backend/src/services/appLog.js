// src/services/appLog.js — structured application logger with auto-trim
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

// Lazy-load to avoid circular dependency (logsController → appLog → logsController)
let _trimAppLogs  = null;
let _trimAuditLogs = null;

function getTrimFns() {
  if (!_trimAppLogs) {
    const lc = require('../controllers/logsController');
    _trimAppLogs   = lc.trimAppLogs;
    _trimAuditLogs = lc.trimAuditLogs;
  }
}

/**
 * Write a structured event to app_logs, then trim if over the 300-row cap.
 * Never throws — falls back to console on error.
 */
function log(level, category, actor, taskId, message, detail = null) {
  try {
    let taskName = null;
    if (taskId) {
      const t = db.prepare('SELECT name FROM tasks WHERE id=?').get(taskId);
      taskName = t ? t.name : null;
    }
    db.prepare(`
      INSERT INTO app_logs (id, level, category, actor, task_id, task_name, message, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), level, category, actor || 'system',
           taskId || null, taskName, message, detail || null);

    // Auto-trim after insert (synchronous, fast SQLite)
    try { getTrimFns(); _trimAppLogs && _trimAppLogs(); } catch {}
  } catch (err) {
    console.error('[AppLog FALLBACK]', level, category, message, err.message);
  }
}

/**
 * Write to audit_logs, then trim if over the 150-row cap.
 */
function audit(actor, action, detail = null) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (id, actor, action, detail) VALUES (?, ?, ?, ?)
    `).run(uuidv4(), actor, action, detail);

    try { getTrimFns(); _trimAuditLogs && _trimAuditLogs(); } catch {}
  } catch (err) {
    console.error('[AuditLog FALLBACK]', actor, action, err.message);
  }
}

module.exports = { log, audit };
