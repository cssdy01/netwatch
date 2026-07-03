// src/controllers/backupController.js — Excel export + import
const { Router } = require('express');
const ExcelJS = require('exceljs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { log, audit } = require('../services/appLog');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── EXPORT ───────────────────────────────────────────────────────────────────

router.get('/export', requireAuth, async (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY name').all();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NetWatch Monitor';
  workbook.created = new Date();

  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e293b' } },
    alignment: { horizontal: 'center' },
    border: {
      bottom: { style: 'thin', color: { argb: 'FF64748b' } },
    },
  };

  // ── Ping sheet ──
  const pingSheet = workbook.addWorksheet('Ping Tasks');
  pingSheet.columns = [
    { header: 'Name',          key: 'name',          width: 25 },
    { header: 'Target IP/Host',key: 'target',        width: 22 },
    { header: 'OS Type',       key: 'os_type',       width: 12 },
    { header: 'Is VM',         key: 'is_vm',         width: 8  },
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

  const pingTasks = tasks.filter(t => t.type === 'PING');
  pingTasks.forEach(t => {
    pingSheet.addRow({
      ...t,
      is_vm: t.is_vm ? 'Yes' : 'No',
      email_enabled: t.email_enabled ? 'Yes' : 'No',
    });
  });

  // ── Application sheet ──
  const appSheet = workbook.addWorksheet('Application Tasks');
  appSheet.columns = [
    { header: 'Name',          key: 'name',          width: 25 },
    { header: 'Server IP',     key: 'target',        width: 18 },
    { header: 'URLs (JSON)',   key: 'urls',          width: 50 },
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

  const appTasks = tasks.filter(t => t.type === 'APPLICATION');
  appTasks.forEach(t => {
    appSheet.addRow({
      ...t,
      urls: t.urls || '[]',
      email_enabled: t.email_enabled ? 'Yes' : 'No',
    });
  });

  // ── Incidents sheet ──
  const incSheet = workbook.addWorksheet('Active Incidents');
  incSheet.columns = [
    { header: 'Task Name',  key: 'task_name',  width: 25 },
    { header: 'Target',     key: 'target',     width: 22 },
    { header: 'Type',       key: 'type',       width: 14 },
    { header: 'T0 (UTC)',   key: 't0',         width: 24 },
    { header: 'L1 Sent At', key: 'l1_sent_at', width: 24 },
    { header: 'L2 Sent At', key: 'l2_sent_at', width: 24 },
    { header: 'L3 Sent At', key: 'l3_sent_at', width: 24 },
    { header: 'Alerted Tiers', key: 'alerted_tiers', width: 16 },
  ];
  incSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  incSheet.getRow(1).height = 22;

  const incidents = db.prepare(`
    SELECT i.*, t.name as task_name, t.target, t.type
    FROM incident_state i JOIN tasks t ON t.id=i.task_id
  `).all();
  incidents.forEach(i => incSheet.addRow(i));

  // Stream
  const date = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-backup-${date}.xlsx"`);

  await workbook.xlsx.write(res);
  res.end();

  log('INFO', 'BACKUP', req.user.username, null, 'Excel export downloaded', null);
  audit(req.user.username, 'EXPORT', `Excel backup downloaded`);
});

// ── IMPORT ───────────────────────────────────────────────────────────────────

router.post('/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const workbook = new ExcelJS.Workbook();
  const errors = [];
  let updated = 0, inserted = 0;

  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch {
    return res.status(400).json({ error: 'Invalid Excel file' });
  }

  const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');

  function processRow(row, type) {
    const rowData = {};
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      rowData[colNum] = cell.value;
    });
    return rowData;
  }

  // Process Ping sheet
  const pingSheet = workbook.getWorksheet('Ping Tasks');
  if (pingSheet) {
    pingSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return; // header

      const name      = String(row.getCell(1).value || '').trim();
      const target    = String(row.getCell(2).value || '').trim();
      const os_type   = String(row.getCell(3).value || '').trim() || 'Linux';
      const is_vm     = String(row.getCell(4).value || '').toLowerCase() === 'yes' ? 1 : 0;
      const interval  = parseInt(row.getCell(5).value) || 5;
      const threshold = parseInt(row.getCell(6).value) || DEFAULT_N;
      const email_l1  = String(row.getCell(7).value || '').trim();
      const email_l2  = String(row.getCell(8).value || '').trim();
      const email_l3  = String(row.getCell(9).value || '').trim();
      const emailEn   = String(row.getCell(10).value || 'Yes').toLowerCase() !== 'no' ? 1 : 0;

      if (!name || !target) { errors.push(`Ping row ${rowNum}: name and target required`); return; }
      if (interval < 3) { errors.push(`Ping row ${rowNum}: interval must be >= 3`); return; }

      const existing = db.prepare('SELECT id FROM tasks WHERE name=? AND type=? AND deleted_at IS NULL').get(name, 'PING');
      if (existing) {
        db.prepare(`UPDATE tasks SET target=?,os_type=?,is_vm=?,interval_min=?,n_threshold=?,
          email_l1=?,email_l2=?,email_l3=?,email_enabled=?,updated_at=datetime('now') WHERE id=?`)
          .run(target, os_type, is_vm, interval, threshold, email_l1, email_l2, email_l3, emailEn, existing.id);
        updated++;
      } else {
        db.prepare(`INSERT INTO tasks (id,name,type,target,os_type,is_vm,interval_min,n_threshold,
          email_l1,email_l2,email_l3,email_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuidv4(), name, 'PING', target, os_type, is_vm, interval, threshold, email_l1, email_l2, email_l3, emailEn);
        inserted++;
      }
    });
  }

  // Process Application sheet
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

      if (!name || !target) { errors.push(`App row ${rowNum}: name and target required`); return; }
      if (interval < 3) { errors.push(`App row ${rowNum}: interval must be >= 3`); return; }

      let urls;
      try { urls = JSON.parse(urlsRaw); if (!Array.isArray(urls) || !urls.length) throw new Error(); }
      catch { errors.push(`App row ${rowNum}: invalid URLs JSON`); return; }

      const existing = db.prepare('SELECT id FROM tasks WHERE name=? AND type=? AND deleted_at IS NULL').get(name, 'APPLICATION');
      if (existing) {
        db.prepare(`UPDATE tasks SET target=?,urls=?,interval_min=?,n_threshold=?,
          email_l1=?,email_l2=?,email_l3=?,email_enabled=?,updated_at=datetime('now') WHERE id=?`)
          .run(target, JSON.stringify(urls), interval, threshold, email_l1, email_l2, email_l3, emailEn, existing.id);
        updated++;
      } else {
        db.prepare(`INSERT INTO tasks (id,name,type,target,urls,interval_min,n_threshold,
          email_l1,email_l2,email_l3,email_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuidv4(), name, 'APPLICATION', target, JSON.stringify(urls), interval, threshold, email_l1, email_l2, email_l3, emailEn);
        inserted++;
      }
    });
  }

  log('INFO', 'BACKUP', req.user.username, null,
    `Import completed: ${inserted} inserted, ${updated} updated, ${errors.length} errors`, null);
  audit(req.user.username, 'IMPORT',
    `Excel import: ${inserted} inserted, ${updated} updated, ${errors.length} errors`);

  res.json({ ok: true, inserted, updated, errors });
});

module.exports = router;
