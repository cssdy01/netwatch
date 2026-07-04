// src/db.js — SQLite database setup + migrations
// Phase 3 changes:
//   - tasks table: added host_mapping_enabled, host_mapping_hostname, host_mapping_ip
//   - host_mappings global table retained (backward compat) but no longer used by monitoring
//   - Safe migrations: ALTER TABLE only when column absent

const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LOG_ARCHIVE_DIR = process.env.LOG_ARCHIVE_DIR || path.join(DATA_DIR, 'log-archives');
if (!fs.existsSync(LOG_ARCHIVE_DIR)) fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'netwatch.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    type                  TEXT NOT NULL CHECK(type IN ('PING','APPLICATION')),
    target                TEXT NOT NULL,
    urls                  TEXT,
    os_type               TEXT,
    is_vm                 INTEGER DEFAULT 0,
    interval_min          INTEGER NOT NULL DEFAULT 5,
    n_threshold           INTEGER NOT NULL DEFAULT 2,
    email_l1              TEXT DEFAULT '',
    email_l2              TEXT DEFAULT '',
    email_l3              TEXT DEFAULT '',
    email_enabled         INTEGER DEFAULT 1,
    is_active             INTEGER DEFAULT 1,
    status                TEXT DEFAULT 'OK' CHECK(status IN ('OK','FAULT')),
    cfc                   INTEGER DEFAULT 0,
    last_checked          TEXT,
    deleted_at            TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    host_mapping_enabled  INTEGER DEFAULT 0,
    host_mapping_hostname TEXT DEFAULT '',
    host_mapping_ip       TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS checks (
    id               TEXT PRIMARY KEY,
    task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    checked_at       TEXT NOT NULL DEFAULT (datetime('now')),
    result           TEXT NOT NULL CHECK(result IN ('PASS','FAIL')),
    response_ms      INTEGER,
    error_raw        TEXT,
    endpoint_results TEXT
  );

  CREATE TABLE IF NOT EXISTS incident_state (
    id               TEXT PRIMARY KEY,
    task_id          TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    t0               TEXT NOT NULL,
    l1_sent_at       TEXT,
    l2_sent_at       TEXT,
    l3_sent_at       TEXT,
    last_l3_repeat   TEXT,
    was_alerted      INTEGER DEFAULT 0,
    alerted_tiers    TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS app_logs (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    level      TEXT NOT NULL CHECK(level IN ('INFO','WARN','ERROR')),
    category   TEXT NOT NULL,
    actor      TEXT DEFAULT 'system',
    task_id    TEXT,
    task_name  TEXT,
    message    TEXT NOT NULL,
    detail     TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT
  );

  -- Kept for backward compat; no longer used by monitoring logic
  CREATE TABLE IF NOT EXISTS host_mappings (
    id         TEXT PRIMARY KEY,
    hostname   TEXT NOT NULL UNIQUE,
    ip_address TEXT NOT NULL,
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS log_archives (
    id           TEXT PRIMARY KEY,
    archive_date TEXT NOT NULL,
    filename     TEXT NOT NULL,
    filepath     TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'ALL',
    size_bytes   INTEGER DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS import_sessions (
    id            TEXT PRIMARY KEY,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT NOT NULL,
    preview_json  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLIED','CANCELLED'))
  );

  CREATE INDEX IF NOT EXISTS idx_checks_task_id     ON checks(task_id);
  CREATE INDEX IF NOT EXISTS idx_checks_checked_at  ON checks(checked_at);
  CREATE INDEX IF NOT EXISTS idx_app_logs_created   ON app_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_app_logs_category  ON app_logs(category);
  CREATE INDEX IF NOT EXISTS idx_app_logs_level     ON app_logs(level);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_status       ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_type         ON tasks(type);
  CREATE INDEX IF NOT EXISTS idx_log_archives_date  ON log_archives(archive_date);
`);

// ── Safe column migrations ────────────────────────────────────────────────────

const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);

if (!cols.includes('is_active')) {
  db.exec('ALTER TABLE tasks ADD COLUMN is_active INTEGER DEFAULT 1');
  console.log('[DB] Migration: added is_active');
}

// Phase 3: per-task host mapping columns
if (!cols.includes('host_mapping_enabled')) {
  db.exec('ALTER TABLE tasks ADD COLUMN host_mapping_enabled INTEGER DEFAULT 0');
  console.log('[DB] Migration: added host_mapping_enabled');
}
if (!cols.includes('host_mapping_hostname')) {
  db.exec("ALTER TABLE tasks ADD COLUMN host_mapping_hostname TEXT DEFAULT ''");
  console.log('[DB] Migration: added host_mapping_hostname');
}
if (!cols.includes('host_mapping_ip')) {
  db.exec("ALTER TABLE tasks ADD COLUMN host_mapping_ip TEXT DEFAULT ''");
  console.log('[DB] Migration: added host_mapping_ip');
}

// ── Value-range fixes ─────────────────────────────────────────────────────────

const MIN_INTERVAL = 3, MAX_INTERVAL = 15;

const fLow = db.prepare('UPDATE tasks SET interval_min=? WHERE interval_min<?').run(MIN_INTERVAL, MIN_INTERVAL);
if (fLow.changes)  console.log(`[DB] Fixed ${fLow.changes} task(s) with interval_min < ${MIN_INTERVAL}`);

const fHigh = db.prepare('UPDATE tasks SET interval_min=? WHERE interval_min>?').run(MAX_INTERVAL, MAX_INTERVAL);
if (fHigh.changes) console.log(`[DB] Fixed ${fHigh.changes} task(s) with interval_min > ${MAX_INTERVAL}`);

const fTL = db.prepare('UPDATE tasks SET n_threshold=1 WHERE n_threshold<1').run();
if (fTL.changes)   console.log(`[DB] Fixed ${fTL.changes} task(s) with n_threshold < 1`);

const fTH = db.prepare('UPDATE tasks SET n_threshold=5 WHERE n_threshold>5').run();
if (fTH.changes)   console.log(`[DB] Fixed ${fTH.changes} task(s) with n_threshold > 5`);

// ── URL-format migration ──────────────────────────────────────────────────────
// Normalise old string-format URLs to object format

const appTasks = db.prepare("SELECT id, urls FROM tasks WHERE type='APPLICATION' AND deleted_at IS NULL").all();
for (const t of appTasks) {
  if (!t.urls) continue;
  let parsed;
  try { parsed = JSON.parse(t.urls); } catch { continue; }
  if (!Array.isArray(parsed)) continue;

  let changed = false;
  const migrated = parsed.map(entry => {
    if (typeof entry === 'string') {
      changed = true;
      return { url: entry, expected_status: null, timeout_sec: 15 };
    }
    return { url: entry.url, expected_status: entry.expected_status || null, timeout_sec: entry.timeout_sec || 15 };
  });

  if (changed) {
    db.prepare('UPDATE tasks SET urls=? WHERE id=?').run(JSON.stringify(migrated), t.id);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

const orphans = db.prepare(`
  DELETE FROM incident_state
  WHERE task_id IN (SELECT id FROM tasks WHERE status='OK' OR is_active=0)
`).run();
if (orphans.changes) console.log(`[DB] Cleared ${orphans.changes} orphaned incident(s)`);

db.prepare("DELETE FROM import_sessions WHERE expires_at < datetime('now')").run();

console.log('[DB] Schema and migrations complete. LOG_ARCHIVE_DIR:', LOG_ARCHIVE_DIR);

module.exports = db;
module.exports.LOG_ARCHIVE_DIR = LOG_ARCHIVE_DIR;
