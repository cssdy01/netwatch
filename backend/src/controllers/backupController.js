// src/controllers/backupController.js — Excel export + import
// Phase 1 changes:
//   - Import now uses a 2-step preview → confirm workflow
//   - POST /api/backup/import-preview: parse file, return summary (no DB changes)
//   - POST /api/backup/import-apply:   apply confirmed session to DB
//   - Supports action: insert_only | update_only | insert_and_update | cancel
//   - Export includes host_mappings sheet
//   - Import reads host_mappings sheet
//   - interval_min validated 3–15; n_threshold validated 1–5
//   - IST timestamps in export filenames and log messages
//   - Keyword field in Application URLs is preserved in export but ignored on import

const { Router } = require('express');
const ExcelJS = require('exceljs');
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { log, audit } = require('../services/appLog');
const { MIN_INTERVAL_MIN, MAX_INTERVAL_MIN, MIN_N_THRESHOLD, MAX_N_THRESHOLD } = require('../middleware/validateTask');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── IST helpers ───────────────────────────────────────────────────────────

function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function nowISTLabel() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-') + ' IST';
}

// ── Header style ──────────────────────────────────────────────────────────

const headerStyle = {
  font:      { bold: true, color: { argb: 'FFFFFFFF' } },
  fill:      { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e293b' } },
  alignment: { horizontal: 'center' },
  border:    { bottom: { style: 'thin', color: { argb: 'FF64748b' } } },
};

// ── EXPORT ────────────────────────────────────────────────────────────────

router.get('/export', requireAuth, async (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY name').all();

  const workbook    = new ExcelJS.Workbook();
  workbook.creator  = 'NetWatch Monitor';
  workbook.created  = new Date();

  // ─ Ping sheet ─
  const pingSheet = workbook.addWorksheet('Ping Tasks');
  pingSheet.columns = [
    { header: 'Name',          key: 'name',          width: 28 },
    { header: 'Target IP/Host',key: 'target',        width: 22 },
    { header: 'OS Type',       key: 'os_type',       width: 12 },
    { header: 'Interval (min)',key: 'interval_min',  width: 14 },
    { header: 'N Threshold',   key: 'n_threshold',   width: 13 },
    { header: 'Email L1',      key: 'email_l1',      width: 35 },
    { header: 'Email L2',      key: 'email_l2',      width: 35 },
    { header: 'Email L3',      key: 'email_l3',      width: 35 },
    { header: 'Email Enabled', key: 'email_enabled', width: 14 },
    { header: 'Status',        key: 'status',        width: 10 },
    { header: 'Last Checked',  key: 'last_checked',  width: 22 },
  ];
  pingSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  pingSheet.getRow(1).height = 22;

  tasks.filter(t => t.type === 'PING').forEach(t => {
    pingSheet.addRow({
      ...t,
      email_enabled: t.email_enabled ? 'Yes' : 'No',
    });
  });

  // ─ Application sheet ─
  const appSheet = workbook.addWorksheet('Application Tasks');
  appSheet.columns = [
    { header: 'Name',          key: 'name',          width: 28 },
    { header: 'Server IP',     key: 'target',        width: 18 },
    { header: 'URLs (JSON)',   key: 'urls',          width: 60 },
    { header: 'Interval (min)',key: 'interval_min',  width: 14 },
    { header: 'N Threshold',   key: 'n_threshold',   width: 13 },
    { header: 'Email L1',      key: 'email_l1',      width: 35 },
    { header: 'Email L2',      key: 'email_l2',      width: 35 },
    { header: 'Email L3',      key: 'email_l3',      width: 35 },
    { header: 'Email Enabled', key: 'email_enabled', width: 14 },
    { header: 'Status',        key: 'status',        width: 10 },
    { header: 'Last Checked',  key: 'last_checked',  width: 22 },
  ];
  appSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  appSheet.getRow(1).height = 22;

  tasks.filter(t => t.type === 'APPLICATION').forEach(t => {
    appSheet.addRow({
      ...t,
      urls: t.urls || '[]',
      email_enabled: t.email_enabled ? 'Yes' : 'No',
    });
  });

  // ─ Host Mappings sheet ─
  const hostSheet = workbook.addWorksheet('Host Mappings');
  hostSheet.columns = [
    { header: 'Hostname',   key: 'hostname',   width: 35 },
    { header: 'IP Address', key: 'ip_address', width: 18 },
    { header: 'Note',       key: 'note',       width: 40 },
  ];
  hostSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  hostSheet.getRow(1).height = 22;

  const mappings = db.prepare('SELECT * FROM host_mappings ORDER BY hostname').all();
  mappings.forEach(m => hostSheet.addRow(m));

  // ─ Active Incidents sheet ─
  const incSheet = workbook.addWorksheet('Active Incidents');
  incSheet.columns = [
    { header: 'Task Name',    key: 'task_name',     width: 28 },
    { header: 'Target',       key: 'target',        width: 22 },
    { header: 'Type',         key: 'type',          width: 14 },
    { header: 'T0 (UTC)',     key: 't0',            width: 24 },
    { header: 'L1 Sent At',   key: 'l1_sent_at',   width: 24 },
    { header: 'L2 Sent At',   key: 'l2_sent_at',   width: 24 },
    { header: 'L3 Sent At',   key: 'l3_sent_at',   width: 24 },
    { header: 'Alerted Tiers',key: 'alerted_tiers', width: 16 },
  ];
  incSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  incSheet.getRow(1).height = 22;

  const incidents = db.prepare(`
    SELECT i.*, t.name as task_name, t.target, t.type
    FROM incident_state i JOIN tasks t ON t.id=i.task_id
  `).all();
  incidents.forEach(i => incSheet.addRow(i));

  const date = todayIST();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-backup-${date}.xlsx"`);

  await workbook.xlsx.write(res);
  res.end();

  log('INFO', 'BACKUP', req.user.username, null, `Backup exported at ${nowISTLabel()}`, null);
  audit(req.user.username, 'EXPORT', `Excel backup downloaded at ${nowISTLabel()}`);
});

// ── IMPORT PREVIEW ────────────────────────────────────────────────────────
// POST /api/backup/import-preview
// Parses file, validates rows, returns summary. Does NOT modify DB.
// Returns a session_id used to confirm/apply.

router.post('/import-preview', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch {
    return res.status(400).json({ error: 'Invalid Excel file — could not parse' });
  }

  const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');
  const preview = {
    ping:         { toInsert: [], toUpdate: [], invalid: [] },
    application:  { toInsert: [], toUpdate: [], invalid: [] },
    hostMappings: { toInsert: [], toUpdate: [], invalid: [] },
  };

  // ─ Parse Ping sheet ─
  const pingSheet = workbook.getWorksheet('Ping Tasks');
  if (pingSheet) {
    pingSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;

      const name      = String(row.getCell(1).value || '').trim();
      const target    = String(row.getCell(2).value || '').trim();
      const os_type   = String(row.getCell(3).value || 'Linux').trim();
      const interval  = parseInt(row.getCell(4).value) || 5;
      const threshold = parseInt(row.getCell(5).value) || DEFAULT_N;
      const email_l1  = String(row.getCell(6).value || '').trim();
      const email_l2  = String(row.getCell(7).value || '').trim();
      const email_l3  = String(row.getCell(8).value || '').trim();
      const emailEn   = String(row.getCell(9).value || 'Yes').toLowerCase() !== 'no' ? 1 : 0;

      const errs = [];
      if (!name)     errs.push('Name is required');
      if (!target)   errs.push('Target is required');
      if (interval < MIN_INTERVAL_MIN || interval > MAX_INTERVAL_MIN)
        errs.push(`Interval must be ${MIN_INTERVAL_MIN}–${MAX_INTERVAL_MIN} minutes (got ${interval})`);
      if (threshold < MIN_N_THRESHOLD || threshold > MAX_N_THRESHOLD)
        errs.push(`N Threshold must be ${MIN_N_THRESHOLD}–${MAX_N_THRESHOLD} (got ${threshold})`);

      if (errs.length) {
        preview.ping.invalid.push({ row: rowNum, name: name || '(blank)', errors: errs });
        return;
      }

      const existing = db.prepare(
        'SELECT id FROM tasks WHERE name=? AND type=? AND deleted_at IS NULL'
      ).get(name, 'PING');

      const record = { name, target, os_type, interval_min: interval, n_threshold: threshold,
        email_l1, email_l2, email_l3, email_enabled: emailEn };

      if (existing) {
        preview.ping.toUpdate.push({ ...record, id: existing.id });
      } else {
        preview.ping.toInsert.push(record);
      }
    });
  }

  // ─ Parse Application sheet ─
  const appSheet = workbook.getWorksheet('Application Tasks');
  if (appSheet) {
    appSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;

      const name      = String(row.getCell(1).value || '').trim();
      const target    = String(row.getCell(2).value || '').trim();
      const urlsRaw   = String(row.getCell(3).value || '[]').trim();
      const interval  = parseInt(row.getCell(4).value) || 5;
      const threshold = parseInt(row.getCell(5).value) || DEFAULT_N;
      const email_l1  = String(row.getCell(6).value || '').trim();
      const email_l2  = String(row.getCell(7).value || '').trim();
      const email_l3  = String(row.getCell(8).value || '').trim();
      const emailEn   = String(row.getCell(9).value || 'Yes').toLowerCase() !== 'no' ? 1 : 0;

      const errs = [];
      if (!name)   errs.push('Name is required');
      if (!target) errs.push('Target is required');
      if (interval < MIN_INTERVAL_MIN || interval > MAX_INTERVAL_MIN)
        errs.push(`Interval must be ${MIN_INTERVAL_MIN}–${MAX_INTERVAL_MIN} minutes (got ${interval})`);
      if (threshold < MIN_N_THRESHOLD || threshold > MAX_N_THRESHOLD)
        errs.push(`N Threshold must be ${MIN_N_THRESHOLD}–${MAX_N_THRESHOLD} (got ${threshold})`);

      let urls = [];
      try {
        urls = JSON.parse(urlsRaw);
        if (!Array.isArray(urls) || urls.length === 0) throw new Error('Empty array');
      } catch {
        errs.push('URLs column must be a valid non-empty JSON array');
      }

      if (errs.length) {
        preview.application.invalid.push({ row: rowNum, name: name || '(blank)', errors: errs });
        return;
      }

      // Normalise URL entries (strip keyword field, keep url/expected_status/timeout_sec)
      const normUrls = urls.map(u => ({
        url:             typeof u === 'string' ? u : (u.url || ''),
        expected_status: u.expected_status || null,
        timeout_sec:     u.timeout_sec || 15,
      }));

      const existing = db.prepare(
        'SELECT id FROM tasks WHERE name=? AND type=? AND deleted_at IS NULL'
      ).get(name, 'APPLICATION');

      const record = { name, target, urls: JSON.stringify(normUrls), interval_min: interval,
        n_threshold: threshold, email_l1, email_l2, email_l3, email_enabled: emailEn };

      if (existing) {
        preview.application.toUpdate.push({ ...record, id: existing.id });
      } else {
        preview.application.toInsert.push(record);
      }
    });
  }

  // ─ Parse Host Mappings sheet ─
  const hostSheet = workbook.getWorksheet('Host Mappings');
  if (hostSheet) {
    hostSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;

      const hostname   = String(row.getCell(1).value || '').trim().toLowerCase();
      const ip_address = String(row.getCell(2).value || '').trim();
      const note       = String(row.getCell(3).value || '').trim();

      const errs = [];
      if (!hostname)   errs.push('Hostname is required');
      if (!ip_address) errs.push('IP address is required');
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip_address)) errs.push('Invalid IP address format');

      if (errs.length) {
        preview.hostMappings.invalid.push({ row: rowNum, hostname: hostname || '(blank)', errors: errs });
        return;
      }

      const existing = db.prepare('SELECT id FROM host_mappings WHERE hostname=?').get(hostname);
      const record   = { hostname, ip_address, note };

      if (existing) {
        preview.hostMappings.toUpdate.push({ ...record, id: existing.id });
      } else {
        preview.hostMappings.toInsert.push(record);
      }
    });
  }

  // Store session (expires in 30 minutes)
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO import_sessions (id, expires_at, preview_json, status)
    VALUES (?, ?, ?, 'PENDING')
  `).run(sessionId, expiresAt, JSON.stringify(preview));

  const summary = {
    session_id:     sessionId,
    expires_at_ist: new Date(expiresAt).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', hour12: false,
    }) + ' IST',
    ping: {
      to_insert: preview.ping.toInsert.length,
      to_update: preview.ping.toUpdate.length,
      invalid:   preview.ping.invalid.length,
      errors:    preview.ping.invalid,
    },
    application: {
      to_insert: preview.application.toInsert.length,
      to_update: preview.application.toUpdate.length,
      invalid:   preview.application.invalid.length,
      errors:    preview.application.invalid,
    },
    host_mappings: {
      to_insert: preview.hostMappings.toInsert.length,
      to_update: preview.hostMappings.toUpdate.length,
      invalid:   preview.hostMappings.invalid.length,
      errors:    preview.hostMappings.invalid,
    },
    totals: {
      to_insert: preview.ping.toInsert.length + preview.application.toInsert.length + preview.hostMappings.toInsert.length,
      to_update: preview.ping.toUpdate.length + preview.application.toUpdate.length + preview.hostMappings.toUpdate.length,
      invalid:   preview.ping.invalid.length  + preview.application.invalid.length  + preview.hostMappings.invalid.length,
    },
  };

  log('INFO', 'BACKUP', req.user.username, null,
    `Import preview: ${summary.totals.to_insert} insert, ${summary.totals.to_update} update, ${summary.totals.invalid} invalid`, null);

  res.json(summary);
});

// ── IMPORT APPLY ──────────────────────────────────────────────────────────
// POST /api/backup/import-apply
// Body: { session_id, action: "insert_only"|"update_only"|"insert_and_update"|"cancel" }

router.post('/import-apply', requireAuth, (req, res) => {
  const { session_id, action } = req.body;

  if (!session_id) return res.status(400).json({ error: 'session_id is required' });
  if (!['insert_only', 'update_only', 'insert_and_update', 'cancel'].includes(action)) {
    return res.status(400).json({ error: 'action must be: insert_only | update_only | insert_and_update | cancel' });
  }

  const session = db.prepare(
    "SELECT * FROM import_sessions WHERE id=? AND status='PENDING'"
  ).get(session_id);

  if (!session) {
    return res.status(404).json({ error: 'Import session not found, expired, or already applied' });
  }

  if (new Date(session.expires_at) < new Date()) {
    db.prepare("UPDATE import_sessions SET status='CANCELLED' WHERE id=?").run(session_id);
    return res.status(410).json({ error: 'Import session has expired. Please re-upload the file.' });
  }

  if (action === 'cancel') {
    db.prepare("UPDATE import_sessions SET status='CANCELLED' WHERE id=?").run(session_id);
    log('INFO', 'BACKUP', req.user.username, null, 'Import cancelled by admin', null);
    return res.json({ ok: true, message: 'Import cancelled' });
  }

  const preview = JSON.parse(session.preview_json);
  const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');

  let inserted = 0;
  let updated  = 0;
  const errors = [];

  const doInsert = action === 'insert_only' || action === 'insert_and_update';
  const doUpdate = action === 'update_only' || action === 'insert_and_update';

  // Apply within a single transaction
  const applyAll = db.transaction(() => {
    // ─ Ping inserts ─
    if (doInsert) {
      for (const r of preview.ping.toInsert) {
        try {
          db.prepare(`
            INSERT INTO tasks (id, name, type, target, os_type, is_vm, interval_min, n_threshold,
              email_l1, email_l2, email_l3, email_enabled)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
          `).run(uuidv4(), r.name, 'PING', r.target, r.os_type || 'Linux',
            r.interval_min, r.n_threshold || DEFAULT_N,
            r.email_l1, r.email_l2, r.email_l3, r.email_enabled);
          inserted++;
        } catch (e) {
          errors.push(`Ping insert "${r.name}": ${e.message}`);
        }
      }
    }

    // ─ Ping updates ─
    if (doUpdate) {
      for (const r of preview.ping.toUpdate) {
        try {
          db.prepare(`
            UPDATE tasks SET target=?, os_type=?, interval_min=?, n_threshold=?,
              email_l1=?, email_l2=?, email_l3=?, email_enabled=?, updated_at=datetime('now')
            WHERE id=?
          `).run(r.target, r.os_type || 'Linux', r.interval_min, r.n_threshold || DEFAULT_N,
            r.email_l1, r.email_l2, r.email_l3, r.email_enabled, r.id);
          updated++;
        } catch (e) {
          errors.push(`Ping update "${r.name}": ${e.message}`);
        }
      }
    }

    // ─ Application inserts ─
    if (doInsert) {
      for (const r of preview.application.toInsert) {
        try {
          db.prepare(`
            INSERT INTO tasks (id, name, type, target, urls, interval_min, n_threshold,
              email_l1, email_l2, email_l3, email_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(uuidv4(), r.name, 'APPLICATION', r.target, r.urls,
            r.interval_min, r.n_threshold || DEFAULT_N,
            r.email_l1, r.email_l2, r.email_l3, r.email_enabled);
          inserted++;
        } catch (e) {
          errors.push(`App insert "${r.name}": ${e.message}`);
        }
      }
    }

    // ─ Application updates ─
    if (doUpdate) {
      for (const r of preview.application.toUpdate) {
        try {
          db.prepare(`
            UPDATE tasks SET target=?, urls=?, interval_min=?, n_threshold=?,
              email_l1=?, email_l2=?, email_l3=?, email_enabled=?, updated_at=datetime('now')
            WHERE id=?
          `).run(r.target, r.urls, r.interval_min, r.n_threshold || DEFAULT_N,
            r.email_l1, r.email_l2, r.email_l3, r.email_enabled, r.id);
          updated++;
        } catch (e) {
          errors.push(`App update "${r.name}": ${e.message}`);
        }
      }
    }

    // ─ Host Mapping inserts ─
    if (doInsert) {
      for (const r of preview.hostMappings.toInsert) {
        try {
          db.prepare(
            'INSERT INTO host_mappings (id, hostname, ip_address, note) VALUES (?, ?, ?, ?)'
          ).run(uuidv4(), r.hostname, r.ip_address, r.note || null);
          inserted++;
        } catch (e) {
          errors.push(`Host mapping insert "${r.hostname}": ${e.message}`);
        }
      }
    }

    // ─ Host Mapping updates ─
    if (doUpdate) {
      for (const r of preview.hostMappings.toUpdate) {
        try {
          db.prepare(`
            UPDATE host_mappings SET ip_address=?, note=?, updated_at=datetime('now') WHERE id=?
          `).run(r.ip_address, r.note || null, r.id);
          updated++;
        } catch (e) {
          errors.push(`Host mapping update "${r.hostname}": ${e.message}`);
        }
      }
    }

    // Mark session applied
    db.prepare("UPDATE import_sessions SET status='APPLIED' WHERE id=?").run(session_id);
  });

  try {
    applyAll();
  } catch (e) {
    return res.status(500).json({ error: `Transaction failed: ${e.message}` });
  }

  log('INFO', 'BACKUP', req.user.username, null,
    `Import applied (${action}): ${inserted} inserted, ${updated} updated, ${errors.length} errors at ${nowISTLabel()}`, null);
  audit(req.user.username, 'IMPORT',
    `Import (${action}): ${inserted} inserted, ${updated} updated, ${errors.length} errors`);

  res.json({ ok: true, action, inserted, updated, errors });
});

// ── Legacy direct import (kept for backward compat; now delegates to preview→apply) ──
// POST /api/backup/import — redirects callers to use the 2-step flow
router.post('/import', requireAuth, upload.single('file'), (req, res) => {
  return res.status(410).json({
    error: 'Direct import is no longer supported. Use the 2-step preview → apply workflow.',
    preview_endpoint: 'POST /api/backup/import-preview',
    apply_endpoint:   'POST /api/backup/import-apply',
  });
});

module.exports = router;