// backend/src/db.js

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || './data';
const LOG_ARCHIVE_DIR =
  process.env.LOG_ARCHIVE_DIR || path.join(DATA_DIR, 'log-archives');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(LOG_ARCHIVE_DIR)) {
  fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'netwatch.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('superadmin', 'user')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL
                        CHECK(type IN ('PING', 'APPLICATION')),
  target                TEXT NOT NULL,
  url                   TEXT DEFAULT '',
  expected_status       INTEGER,
  timeout_sec           INTEGER DEFAULT 15,
  os_type               TEXT,
  is_vm                 INTEGER NOT NULL DEFAULT 0,

  interval_min          INTEGER NOT NULL DEFAULT 5,
  n_threshold           INTEGER NOT NULL DEFAULT 2,
  l2_delay_min          INTEGER NOT NULL DEFAULT 2880,
  l3_repeat_min         INTEGER NOT NULL DEFAULT 2880,

  email_l1              TEXT DEFAULT '',
  email_l2              TEXT DEFAULT '',
  email_l3              TEXT DEFAULT '',
  email_enabled         INTEGER NOT NULL DEFAULT 1,

  is_active             INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'OK'
                        CHECK(status IN ('OK', 'FAULT')),
  cfc                   INTEGER NOT NULL DEFAULT 0,
  last_checked          TEXT,
  deleted_at            TEXT,

  host_mapping_enabled  INTEGER NOT NULL DEFAULT 0,
  host_mapping_hostname TEXT DEFAULT '',
  host_mapping_ip       TEXT DEFAULT '',

  snmp_enabled          INTEGER NOT NULL DEFAULT 0,
  snmp_version          TEXT NOT NULL DEFAULT '3'
                        CHECK(snmp_version IN ('2c', '3')),
  snmp_port             INTEGER NOT NULL DEFAULT 161,

  snmp_community_enc    TEXT DEFAULT '',
  snmp_username         TEXT DEFAULT '',
  snmp_auth_password_enc TEXT DEFAULT '',
  snmp_priv_password_enc TEXT DEFAULT '',

  snmp_security_level   TEXT NOT NULL DEFAULT 'authNoPriv'
                        CHECK(
                          snmp_security_level IN (
                            'noAuthNoPriv',
                            'authNoPriv',
                            'authPriv'
                          )
                        ),

  snmp_auth_protocol    TEXT NOT NULL DEFAULT 'SHA'
                        CHECK(
                          snmp_auth_protocol IN (
                            'NONE',
                            'MD5',
                            'SHA',
                            'SHA224',
                            'SHA256',
                            'SHA384',
                            'SHA512'
                          )
                        ),

  snmp_priv_protocol    TEXT NOT NULL DEFAULT 'NONE'
                        CHECK(
                          snmp_priv_protocol IN (
                            'NONE',
                            'DES',
                            'AES',
                            'AES192',
                            'AES256'
                          )
                        ),

  snmp_interval_min     INTEGER NOT NULL DEFAULT 15,
  snmp_timeout_sec      INTEGER NOT NULL DEFAULT 5,
  snmp_retries          INTEGER NOT NULL DEFAULT 1,

  snmp_extend_logs_oid      TEXT DEFAULT '',
  snmp_extend_reboot_oid    TEXT DEFAULT '',
  snmp_extend_shutdown_oid  TEXT DEFAULT '',

  snmp_last_checked     TEXT,
  snmp_last_status      TEXT
                        CHECK(
                          snmp_last_status IS NULL OR
                          snmp_last_status IN ('PASS', 'FAIL')
                        ),
  snmp_last_error       TEXT,

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checks (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL
                   REFERENCES tasks(id) ON DELETE CASCADE,
  checked_at       TEXT NOT NULL DEFAULT (datetime('now')),
  result           TEXT NOT NULL CHECK(result IN ('PASS', 'FAIL')),
  response_ms      INTEGER,
  error_raw        TEXT,
  endpoint_results TEXT
);

CREATE TABLE IF NOT EXISTS snmp_checks (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL
                    REFERENCES tasks(id) ON DELETE CASCADE,
  checked_at        TEXT NOT NULL DEFAULT (datetime('now')),
  result            TEXT NOT NULL CHECK(result IN ('PASS', 'FAIL')),

  hostname          TEXT,
  uptime_seconds    INTEGER,

  cpu_usage         REAL,
  memory_used       INTEGER,
  memory_total      INTEGER,
  memory_usage      REAL,

  disk_usage_json   TEXT DEFAULT '[]',

  last_reboot_at    TEXT,
  last_shutdown_at  TEXT,
  system_logs_json  TEXT DEFAULT '[]',

  response_ms       INTEGER,
  error_raw         TEXT
);

CREATE TABLE IF NOT EXISTS incident_state (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL UNIQUE
                   REFERENCES tasks(id) ON DELETE CASCADE,
  t0               TEXT NOT NULL,
  l1_sent_at       TEXT,
  l2_sent_at       TEXT,
  l3_sent_at       TEXT,
  last_l3_repeat   TEXT,
  was_alerted      INTEGER NOT NULL DEFAULT 0,
  alerted_tiers    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS app_logs (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  level       TEXT NOT NULL CHECK(level IN ('INFO', 'WARN', 'ERROR')),
  category    TEXT NOT NULL,
  actor       TEXT DEFAULT 'system',
  task_id     TEXT,
  task_name   TEXT,
  message     TEXT NOT NULL,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS log_archives (
  id            TEXT PRIMARY KEY,
  archive_date  TEXT NOT NULL,
  filename      TEXT NOT NULL,
  filepath      TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'ALL',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_sessions (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  preview_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK(status IN ('PENDING', 'APPLIED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_checks_task_id
  ON checks(task_id);

CREATE INDEX IF NOT EXISTS idx_checks_checked_at
  ON checks(checked_at);

CREATE INDEX IF NOT EXISTS idx_snmp_checks_task_id
  ON snmp_checks(task_id);

CREATE INDEX IF NOT EXISTS idx_snmp_checks_checked_at
  ON snmp_checks(checked_at);

CREATE INDEX IF NOT EXISTS idx_snmp_checks_task_checked
  ON snmp_checks(task_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_logs_created
  ON app_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_app_logs_category
  ON app_logs(category);

CREATE INDEX IF NOT EXISTS idx_app_logs_level
  ON app_logs(level);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_tasks_type
  ON tasks(type);

CREATE INDEX IF NOT EXISTS idx_tasks_active
  ON tasks(is_active);

CREATE INDEX IF NOT EXISTS idx_tasks_snmp_enabled
  ON tasks(snmp_enabled);

CREATE INDEX IF NOT EXISTS idx_log_archives_date
  ON log_archives(archive_date);
`);

// Keep task values inside the supported limits.
// These statements are safe for a fresh database and protect against bad imports.
const MIN_INTERVAL = parseInt(
  process.env.MIN_MONITOR_INTERVAL_MIN || '3',
  10
);

const MAX_INTERVAL = parseInt(
  process.env.MAX_MONITOR_INTERVAL_MIN || '15',
  10
);

const MIN_SNMP_INTERVAL = parseInt(
  process.env.SNMP_MIN_INTERVAL_MIN || '3',
  10
);

const MAX_SNMP_INTERVAL = parseInt(
  process.env.SNMP_MAX_INTERVAL_MIN || '1440',
  10
);

db.prepare(`
  UPDATE tasks
  SET interval_min = ?
  WHERE interval_min < ?
`).run(MIN_INTERVAL, MIN_INTERVAL);

db.prepare(`
  UPDATE tasks
  SET interval_min = ?
  WHERE interval_min > ?
`).run(MAX_INTERVAL, MAX_INTERVAL);

db.prepare(`
  UPDATE tasks
  SET snmp_interval_min = ?
  WHERE snmp_interval_min < ?
`).run(MIN_SNMP_INTERVAL, MIN_SNMP_INTERVAL);

db.prepare(`
  UPDATE tasks
  SET snmp_interval_min = ?
  WHERE snmp_interval_min > ?
`).run(MAX_SNMP_INTERVAL, MAX_SNMP_INTERVAL);

db.prepare(`
  UPDATE tasks
  SET n_threshold = 1
  WHERE n_threshold < 1
`).run();

db.prepare(`
  UPDATE tasks
  SET n_threshold = 5
  WHERE n_threshold > 5
`).run();

// Remove stale incident rows that should not remain open.
db.prepare(`
  DELETE FROM incident_state
  WHERE task_id IN (
    SELECT id
    FROM tasks
    WHERE status = 'OK'
       OR is_active = 0
       OR deleted_at IS NOT NULL
  )
`).run();

// Remove expired backup/import preview sessions.
db.prepare(`
  DELETE FROM import_sessions
  WHERE expires_at < datetime('now')
`).run();

module.exports = db;
module.exports.DB_PATH = DB_PATH;
module.exports.DATA_DIR = DATA_DIR;
module.exports.LOG_ARCHIVE_DIR = LOG_ARCHIVE_DIR;