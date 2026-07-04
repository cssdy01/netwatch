// src/controllers/backupController.js — Phase 3
// Export / Import now includes per-task host mapping fields:
//   host_mapping_enabled, host_mapping_hostname, host_mapping_ip
// Global host_mappings sheet removed from new exports (not used by monitoring).
// Legacy import still handles old host_mappings sheet gracefully (no-op).

const { Router } = require('express');
const ExcelJS    = require('exceljs');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const db         = require('../db');
const { requireAuth } = require('../middleware/auth');
const { log, audit } = require('../services/appLog');
const { MIN_INTERVAL_MIN, MAX_INTERVAL_MIN, MIN_N_THRESHOLD, MAX_N_THRESHOLD, isValidIpv4 } = require('../middleware/validateTask');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── IST helpers ────────────────────────────────────────────────────────────────

function todayIST() {
  const ist = new Date(Date.now() + 330 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function nowISTLabel() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(/\//g, '-') + ' IST';
}

const headerStyle = {
  font:      { bold: true, color: { argb: 'FFFFFFFF' } },
  fill:      { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e293b' } },
  alignment: { horizontal: 'center' },
  border:    { bottom: { style: 'thin', color: { argb: 'FF64748b' } } },
};

// ── EXPORT ────────────────────────────────────────────────────────────────────

router.get('/export', requireAuth, async (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY name').all();

  const wb      = new ExcelJS.Workbook();
  wb.creator    = 'NetWatch Monitor';
  wb.created    = new Date();

  // ─ Ping Tasks ─
  const pingSheet = wb.addWorksheet('Ping Tasks');
  pingSheet.columns = [
    { header: 'Name',           key: 'name',          width: 28 },
    { header: 'Target IP/Host', key: 'target',        width: 22 },
    { header: 'OS Type',        key: 'os_type',       width: 12 },
    { header: 'Interval (min)', key: 'interval_min',  width: 14 },
    { header: 'N Threshold',    key: 'n_threshold',   width: 13 },
    { header: 'Email L1',       key: 'email_l1',      width: 35 },
    { header: 'Email L2',       key: 'email_l2',      width: 35 },
    { header: 'Email L3',       key: 'email_l3',      width: 35 },
    { header: 'Email Enabled',  key: 'email_enabled', width: 14 },
    { header: 'Status',         key: 'status',        width: 10 },
    { header: 'Last Checked',   key: 'last_checked',  width: 22 },
  ];
  pingSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  tasks.filter(t => t.type === 'PING').forEach(t =>
    pingSheet.addRow({ ...t, email_enabled: t.email_enabled ? 'Yes' : 'No' })
  );

  // ─ Application Tasks (with host mapping columns) ─
  const appSheet = wb.addWorksheet('Application Tasks');
  appSheet.columns = [
    { header: 'Name',                    key: 'name',                   width: 28 },
    { header: 'Server IP',               key: 'target',                 width: 18 },
    { header: 'URLs (JSON)',             key: 'urls',                   width: 60 },
    { header: 'Interval (min)',          key: 'interval_min',           width: 14 },
    { header: 'N Threshold',             key: 'n_threshold',            width: 13 },
    { header: 'Email L1',               key: 'email_l1',               width: 35 },
    { header: 'Email L2',               key: 'email_l2',               width: 35 },
    { header: 'Email L3',               key: 'email_l3',               width: 35 },
    { header: 'Email Enabled',          key: 'email_enabled',          width: 14 },
    { header: 'Host Mapping Enabled',   key: 'host_mapping_enabled',   width: 20 },
    { header: 'Host Mapping Hostname',  key: 'host_mapping_hostname',  width: 30 },
    { header: 'Host Mapping IP',        key: 'host_mapping_ip',        width: 18 },
    { header: 'Status',                 key: 'status',                 width: 10 },
    { header: 'Last Checked',           key: 'last_checked',           width: 22 },
  ];
  appSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  tasks.filter(t => t.type === 'APPLICATION').forEach(t =>
    appSheet.addRow({
      ...t,
      urls:                  t.urls || '[]',
      email_enabled:         t.email_enabled ? 'Yes' : 'No',
      host_mapping_enabled:  t.host_mapping_enabled ? 'Yes' : 'No',
      host_mapping_hostname: t.host_mapping_hostname || '',
      host_mapping_ip:       t.host_mapping_ip       || '',
    })
  );

  const date = todayIST();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-backup-${date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();

  log('INFO', 'BACKUP', req.user.username, null, `Backup exported at ${nowISTLabel()}`, null);
  audit(req.user.username, 'EXPORT', `Excel backup downloaded at ${nowISTLabel()}`);
});

// ── IMPORT PREVIEW ─────────────────────────────────────────────────────────────

router.post('/import-preview', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); }
  catch { return res.status(400).json({ error: 'Invalid Excel file — could not parse' }); }

  const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');
  const preview = {
    ping:        { toInsert: [], toUpdate: [], invalid: [] },
    application: { toInsert: [], toUpdate: [], invalid: [] },
  };

  // ─ Ping sheet ─
  const pingSheet = wb.getWorksheet('Ping Tasks');
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
      if (!name)   errs.push('Name is required');
      if (!target) errs.push('Target is required');
      if (interval < MIN_INTERVAL_MIN || interval > MAX_INTERVAL_MIN)
        errs.push(`Interval must be ${MIN_INTERVAL_MIN}–${MAX_INTERVAL_MIN} min (got ${interval})`);
      if (threshold < MIN_N_THRESHOLD || threshold > MAX_N_THRESHOLD)
        errs.push(`N Threshold must be ${MIN_N_THRESHOLD}–${MAX_N_THRESHOLD} (got ${threshold})`);

      if (errs.length) { preview.ping.invalid.push({ row: rowNum, name: name || '(blank)', errors: errs }); return; }

      const existing = db.prepare(
        "SELECT id FROM tasks WHERE name=? AND type='PING' AND deleted_at IS NULL"
      ).get(name);
      const record = { name, target, os_type, interval_min: interval, n_threshold: threshold,
        email_l1, email_l2, email_l3, email_enabled: emailEn };
      if (existing) preview.ping.toUpdate.push({ ...record, id: existing.id });
      else          preview.ping.toInsert.push(record);
    });
  }

  // ─ Application sheet ─
  const appSheet = wb.getWorksheet('Application Tasks');
  if (appSheet) {
    appSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;
      const name            = String(row.getCell(1).value  || '').trim();
      const target          = String(row.getCell(2).value  || '').trim();
      const urlsRaw         = String(row.getCell(3).value  || '[]').trim();
      const interval        = parseInt(row.getCell(4).value) || 5;
      const threshold       = parseInt(row.getCell(5).value) || DEFAULT_N;
      const email_l1        = String(row.getCell(6).value  || '').trim();
      const email_l2        = String(row.getCell(7).value  || '').trim();
      const email_l3        = String(row.getCell(8).value  || '').trim();
      const emailEn         = String(row.getCell(9).value  || 'Yes').toLowerCase() !== 'no' ? 1 : 0;
      const hmEnabledRaw    = String(row.getCell(10).value || 'No').toLowerCase();
      const hmEnabled       = (hmEnabledRaw === 'yes' || hmEnabledRaw === '1' || hmEnabledRaw === 'true') ? 1 : 0;
      const hmHostname      = String(row.getCell(11).value || '').trim();
      const hmIp            = String(row.getCell(12).value || '').trim();

      const errs = [];
      if (!name)   errs.push('Name is required');
      if (!target) errs.push('Target is required');
      if (interval < MIN_INTERVAL_MIN || interval > MAX_INTERVAL_MIN)
        errs.push(`Interval must be ${MIN_INTERVAL_MIN}–${MAX_INTERVAL_MIN} min (got ${interval})`);
      if (threshold < MIN_N_THRESHOLD || threshold > MAX_N_THRESHOLD)
        errs.push(`N Threshold must be ${MIN_N_THRESHOLD}–${MAX_N_THRESHOLD} (got ${threshold})`);

      let urls = [];
      try {
        urls = JSON.parse(urlsRaw);
        if (!Array.isArray(urls) || !urls.length) throw new Error('empty');
      } catch { errs.push('URLs column must be a valid non-empty JSON array'); }

      if (hmEnabled) {
        if (!hmHostname) errs.push('Host mapping enabled but hostname is missing');
        if (!hmIp)       errs.push('Host mapping enabled but IP address is missing');
        else if (!isValidIpv4(hmIp)) errs.push(`Host mapping IP "${hmIp}" is not a valid IPv4 address`);
      }

      if (errs.length) { preview.application.invalid.push({ row: rowNum, name: name || '(blank)', errors: errs }); return; }

      const normUrls = urls.map(u => ({
        url:             typeof u === 'string' ? u : (u.url || ''),
        expected_status: u.expected_status || null,
        timeout_sec:     u.timeout_sec     || 15,
      }));

      const existing = db.prepare(
        "SELECT id FROM tasks WHERE name=? AND type='APPLICATION' AND deleted_at IS NULL"
      ).get(name);
      const record = {
        name, target, urls: JSON.stringify(normUrls), interval_min: interval,
        n_threshold: threshold, email_l1, email_l2, email_l3, email_enabled: emailEn,
        host_mapping_enabled: hmEnabled, host_mapping_hostname: hmHostname, host_mapping_ip: hmIp,
      };
      if (existing) preview.application.toUpdate.push({ ...record, id: existing.id });
      else          preview.application.toInsert.push(record);
    });
  }

  // Store session (30-minute TTL)
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO import_sessions (id, expires_at, preview_json, status) VALUES (?, ?, ?, 'PENDING')
  `).run(sessionId, expiresAt, JSON.stringify(preview));

  const toIST = v => new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';

  const summary = {
    session_id:     sessionId,
    expires_at_ist: toIST(expiresAt),
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
    totals: {
      to_insert: preview.ping.toInsert.length + preview.application.toInsert.length,
      to_update: preview.ping.toUpdate.length + preview.application.toUpdate.length,
      invalid:   preview.ping.invalid.length  + preview.application.invalid.length,
    },
  };

  log('INFO', 'BACKUP', req.user.username, null,
    `Import preview: ${summary.totals.to_insert} insert, ${summary.totals.to_update} update, ${summary.totals.invalid} invalid`, null);
  res.json(summary);
});

// ── IMPORT APPLY ───────────────────────────────────────────────────────────────

router.post('/import-apply', requireAuth, (req, res) => {
  const { session_id, action } = req.body;

  if (!session_id) return res.status(400).json({ error: 'session_id is required' });
  if (!['insert_only','update_only','insert_and_update','cancel'].includes(action))
    return res.status(400).json({ error: 'action must be: insert_only | update_only | insert_and_update | cancel' });

  const session = db.prepare("SELECT * FROM import_sessions WHERE id=? AND status='PENDING'").get(session_id);
  if (!session) return res.status(404).json({ error: 'Import session not found, expired, or already applied' });

  if (new Date(session.expires_at) < new Date()) {
    db.prepare("UPDATE import_sessions SET status='CANCELLED' WHERE id=?").run(session_id);
    return res.status(410).json({ error: 'Import session has expired. Please re-upload the file.' });
  }

  if (action === 'cancel') {
    db.prepare("UPDATE import_sessions SET status='CANCELLED' WHERE id=?").run(session_id);
    log('INFO', 'BACKUP', req.user.username, null, 'Import cancelled', null);
    return res.json({ ok: true, message: 'Import cancelled' });
  }

  const preview  = JSON.parse(session.preview_json);
  const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');
  const doInsert = action === 'insert_only' || action === 'insert_and_update';
  const doUpdate = action === 'update_only' || action === 'insert_and_update';

  let inserted = 0, updated = 0;
  const errors = [];

  const applyAll = db.transaction(() => {
    if (doInsert) {
      for (const r of preview.ping.toInsert) {
        try {
          db.prepare(`
            INSERT INTO tasks (id,name,type,target,os_type,is_vm,interval_min,n_threshold,
              email_l1,email_l2,email_l3,email_enabled)
            VALUES (?,?,?,?,?,0,?,?,?,?,?,?)
          `).run(uuidv4(), r.name, 'PING', r.target, r.os_type||'Linux',
            r.interval_min, r.n_threshold||DEFAULT_N, r.email_l1, r.email_l2, r.email_l3, r.email_enabled);
          inserted++;
        } catch (e) { errors.push(`Ping insert "${r.name}": ${e.message}`); }
      }
      for (const r of preview.application.toInsert) {
        try {
          db.prepare(`
            INSERT INTO tasks (id,name,type,target,urls,interval_min,n_threshold,
              email_l1,email_l2,email_l3,email_enabled,
              host_mapping_enabled,host_mapping_hostname,host_mapping_ip)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(uuidv4(), r.name, 'APPLICATION', r.target, r.urls, r.interval_min,
            r.n_threshold||DEFAULT_N, r.email_l1, r.email_l2, r.email_l3, r.email_enabled,
            r.host_mapping_enabled||0, r.host_mapping_hostname||'', r.host_mapping_ip||'');
          inserted++;
        } catch (e) { errors.push(`App insert "${r.name}": ${e.message}`); }
      }
    }

    if (doUpdate) {
      for (const r of preview.ping.toUpdate) {
        try {
          db.prepare(`
            UPDATE tasks SET target=?,os_type=?,interval_min=?,n_threshold=?,
              email_l1=?,email_l2=?,email_l3=?,email_enabled=?,updated_at=datetime('now')
            WHERE id=?
          `).run(r.target, r.os_type||'Linux', r.interval_min, r.n_threshold||DEFAULT_N,
            r.email_l1, r.email_l2, r.email_l3, r.email_enabled, r.id);
          updated++;
        } catch (e) { errors.push(`Ping update "${r.name}": ${e.message}`); }
      }
      for (const r of preview.application.toUpdate) {
        try {
          db.prepare(`
            UPDATE tasks SET target=?,urls=?,interval_min=?,n_threshold=?,
              email_l1=?,email_l2=?,email_l3=?,email_enabled=?,
              host_mapping_enabled=?,host_mapping_hostname=?,host_mapping_ip=?,
              updated_at=datetime('now')
            WHERE id=?
          `).run(r.target, r.urls, r.interval_min, r.n_threshold||DEFAULT_N,
            r.email_l1, r.email_l2, r.email_l3, r.email_enabled,
            r.host_mapping_enabled||0, r.host_mapping_hostname||'', r.host_mapping_ip||'', r.id);
          updated++;
        } catch (e) { errors.push(`App update "${r.name}": ${e.message}`); }
      }
    }

    db.prepare("UPDATE import_sessions SET status='APPLIED' WHERE id=?").run(session_id);
  });

  try { applyAll(); }
  catch (e) { return res.status(500).json({ error: `Transaction failed: ${e.message}` }); }

  log('INFO', 'BACKUP', req.user.username, null,
    `Import applied (${action}): ${inserted} inserted, ${updated} updated, ${errors.length} errors at ${nowISTLabel()}`, null);
  audit(req.user.username, 'IMPORT', `Import (${action}): ${inserted} inserted, ${updated} updated`);
  res.json({ ok: true, action, inserted, updated, errors });
});

// Keep old direct-import endpoint as 410 Gone
router.post('/import', requireAuth, upload.single('file'), (_req, res) => {
  res.status(410).json({
    error: 'Direct import removed. Use 2-step flow.',
    preview_endpoint: 'POST /api/backup/import-preview',
    apply_endpoint:   'POST /api/backup/import-apply',
  });
});

module.exports = router;
