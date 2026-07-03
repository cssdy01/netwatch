// src/db.js — SQLite database setup + migrations
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'netwatch.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('PING','APPLICATION')),
    target        TEXT NOT NULL,
    urls          TEXT,
    os_type       TEXT,
    is_vm         INTEGER DEFAULT 0,
    interval_min  INTEGER NOT NULL DEFAULT 5 CHECK(interval_min >= 5),
    n_threshold   INTEGER NOT NULL DEFAULT 2,
    email_l1      TEXT DEFAULT '',
    email_l2      TEXT DEFAULT '',
    email_l3      TEXT DEFAULT '',
    email_enabled INTEGER DEFAULT 1,
    is_active     INTEGER DEFAULT 1,
    status        TEXT DEFAULT 'OK' CHECK(status IN ('OK','FAULT')),
    cfc           INTEGER DEFAULT 0,
    last_checked  TEXT,
    deleted_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checks (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
    result        TEXT NOT NULL CHECK(result IN ('PASS','FAIL')),
    response_ms   INTEGER,
    error_raw     TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_checks_task_id    ON checks(task_id);
  CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at);
  CREATE INDEX IF NOT EXISTS idx_app_logs_created  ON app_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_app_logs_category ON app_logs(category);
  CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
`);

// ── Migrations (safe to run every startup) ────────────────────────────────────

const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);

if (!cols.includes('is_active')) {
  db.exec('ALTER TABLE tasks ADD COLUMN is_active INTEGER DEFAULT 1');
  console.log('[DB] Migration: added is_active column');
}

// FIX: enforce minimum interval of 5 (matches validateTask.js and MIN_INTERVAL_MIN).
// Previously used 3 here, which allowed tasks to fire far too frequently and
// contributed to mail storms when combined with the L1 cooldown bug.
const MIN_INTERVAL = 5;
const fixedIntervals = db.prepare(
  'UPDATE tasks SET interval_min = ? WHERE interval_min < ?'
).run(MIN_INTERVAL, MIN_INTERVAL);
if (fixedIntervals.changes > 0) {
  console.log(`[DB] Migration: fixed ${fixedIntervals.changes} task(s) with interval_min < ${MIN_INTERVAL} → set to ${MIN_INTERVAL}`);
}

// Clear stale orphaned incidents for tasks that are now OK or inactive
const clearOrphans = db.prepare(`
  DELETE FROM incident_state
  WHERE task_id IN (
    SELECT id FROM tasks WHERE status = 'OK' OR is_active = 0
  )
`).run();
if (clearOrphans.changes > 0) {
  console.log(`[DB] Migration: cleared ${clearOrphans.changes} orphaned incident(s) for OK/inactive tasks`);
}

module.exports = db;
