// src/db.js
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

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL CHECK(role IN ('superadmin','user')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    type                  TEXT NOT NULL CHECK(type IN ('PING','APPLICATION')),
    target                TEXT NOT NULL,
    url                   TEXT DEFAULT '',
    expected_status       INTEGER,
    timeout_sec           INTEGER DEFAULT 15,
    os_type               TEXT,
    is_vm                 INTEGER DEFAULT 0,
    interval_min          INTEGER NOT NULL DEFAULT 5,
    n_threshold           INTEGER NOT NULL DEFAULT 2,
    l2_delay_min          INTEGER NOT NULL DEFAULT 2880,
    l3_repeat_min         INTEGER NOT NULL DEFAULT 2880,
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

// Safe column migrations
const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);

if (!cols.includes('url')) {
  db.exec("ALTER TABLE tasks ADD COLUMN url TEXT DEFAULT ''");
  db.exec('ALTER TABLE tasks ADD COLUMN expected_status INTEGER');
  db.exec('ALTER TABLE tasks ADD COLUMN timeout_sec INTEGER DEFAULT 15');
  db.exec('ALTER TABLE tasks ADD COLUMN l2_delay_min INTEGER NOT NULL DEFAULT 2880');
  db.exec('ALTER TABLE tasks ADD COLUMN l3_repeat_min INTEGER NOT NULL DEFAULT 2880');
  console.log('[DB] Migration: added single url and custom email timings');
}

if (!cols.includes('is_active')) {
  db.exec('ALTER TABLE tasks ADD COLUMN is_active INTEGER DEFAULT 1');
}
if (!cols.includes('host_mapping_enabled')) {
  db.exec('ALTER TABLE tasks ADD COLUMN host_mapping_enabled INTEGER DEFAULT 0');
  db.exec("ALTER TABLE tasks ADD COLUMN host_mapping_hostname TEXT DEFAULT ''");
  db.exec("ALTER TABLE tasks ADD COLUMN host_mapping_ip TEXT DEFAULT ''");
}

const MIN_INTERVAL = 3, MAX_INTERVAL = 15;
db.prepare('UPDATE tasks SET interval_min=? WHERE interval_min<?').run(MIN_INTERVAL, MIN_INTERVAL);
db.prepare('UPDATE tasks SET interval_min=? WHERE interval_min>?').run(MAX_INTERVAL, MAX_INTERVAL);
db.prepare('UPDATE tasks SET n_threshold=1 WHERE n_threshold<1').run();
db.prepare('UPDATE tasks SET n_threshold=5 WHERE n_threshold>5').run();

// Clean up orphans
db.prepare(`DELETE FROM incident_state WHERE task_id IN (SELECT id FROM tasks WHERE status='OK' OR is_active=0)`).run();
db.prepare("DELETE FROM import_sessions WHERE expires_at < datetime('now')").run();

module.exports = db;
module.exports.LOG_ARCHIVE_DIR = LOG_ARCHIVE_DIR;