// backend/src/services/monitoringService.js
//
// Monitoring scheduler and incident state machine.
// SNMP is integrated into PING/System tasks while ICMP remains the
// availability source. SNMP failures are stored separately and do not
// create availability incidents.

const cron = require('node-cron');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { log } = require('./appLog');
const pingAgent = require('../agents/pingAgent');
const webAgent = require('../agents/webAgent');
const mailService = require('../mail/mailService');

const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2', 10);
const POLL_CYCLE_CRON = process.env.POLL_CYCLE_CRON || '*/1 * * * *';
const MIN_INTERVAL_MIN = parseInt(process.env.MIN_MONITOR_INTERVAL_MIN || '3', 10);
const MAX_INTERVAL_MIN = parseInt(process.env.MAX_MONITOR_INTERVAL_MIN || '15', 10);
const MIN_SNMP_INTERVAL_MIN = parseInt(process.env.SNMP_MIN_INTERVAL_MIN || '3', 10);
const MAX_SNMP_INTERVAL_MIN = parseInt(process.env.SNMP_MAX_INTERVAL_MIN || '1440', 10);
const SNMP_RETENTION_DAYS = parseInt(process.env.SNMP_RETENTION_DAYS || '30', 10);

let schedulersStarted = false;
let pollRunning = false;
let escalationRunning = false;
const runningTaskIds = new Set();

function nowIso() {
  return new Date().toISOString();
}

function parseBoolean(value) {
  return value === true || value === 1 || value === '1' ||
    value === 'true' || value === 'yes' || value === 'on';
}

function appendTier(existing, tier) {
  const values = new Set(
    String(existing || '').split(',').map((item) => item.trim()).filter(Boolean)
  );
  values.add(tier);
  return [...values].join(',');
}

function getCredentialKey() {
  const secret = String(process.env.SNMP_CREDENTIAL_KEY || '');
  if (secret.length < 32) {
    throw new Error('SNMP_CREDENTIAL_KEY must contain at least 32 characters');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function decryptCredential(encryptedValue) {
  if (!encryptedValue) return '';

  const parts = String(encryptedValue).split(':');
  if (parts.length !== 3) {
    throw new Error('Stored SNMP credential format is invalid');
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getCredentialKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function addPlainSnmpCredentials(task) {
  if (!task || !parseBoolean(task.snmp_enabled)) return task;

  return {
    ...task,
    snmp_community: decryptCredential(task.snmp_community_enc),
    snmp_auth_password: decryptCredential(task.snmp_auth_password_enc),
    snmp_priv_password: decryptCredential(task.snmp_priv_password_enc),
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = parseInt(value, 10);
  const selected = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(maximum, Math.max(minimum, selected));
}

function isDue(lastChecked, intervalMinutes, currentTime) {
  if (!lastChecked) return true;
  const previous = new Date(lastChecked).getTime();
  if (Number.isNaN(previous)) return true;
  return currentTime - previous >= intervalMinutes * 60 * 1000;
}

function shouldRunNormalCheck(task, currentTime) {
  const interval = boundedInteger(
    task.interval_min,
    MIN_INTERVAL_MIN,
    MIN_INTERVAL_MIN,
    MAX_INTERVAL_MIN
  );
  return isDue(task.last_checked, interval, currentTime);
}

function shouldRunSnmp(task, currentTime) {
  if (task.type !== 'PING' || !parseBoolean(task.snmp_enabled)) return false;

  const interval = boundedInteger(
    task.snmp_interval_min,
    15,
    MIN_SNMP_INTERVAL_MIN,
    MAX_SNMP_INTERVAL_MIN
  );
  return isDue(task.snmp_last_checked, interval, currentTime);
}

async function dispatchAgent(task) {
  if (task.type === 'PING') return pingAgent.run(task);
  if (task.type === 'APPLICATION') return webAgent.run(task);
  throw new Error(`Unknown task type: ${task.type}`);
}

function saveSnmpResult(task, snmpResult) {
  if (!snmpResult) return;

  const checkedAt = nowIso();
  const filesystems = Array.isArray(snmpResult.filesystems)
    ? snmpResult.filesystems
    : [];
  const systemLogs = Array.isArray(snmpResult.systemLogs)
    ? snmpResult.systemLogs.slice(-500)
    : [];
  const warnings = Array.isArray(snmpResult.warnings)
    ? snmpResult.warnings
    : [];

  let errorRaw = snmpResult.errorRaw || null;
  if (!errorRaw && warnings.length) {
    errorRaw = warnings.join('; ').slice(0, 8000);
  }

  db.prepare(`
    INSERT INTO snmp_checks (
      id, task_id, checked_at, result, hostname, uptime_seconds,
      cpu_usage, memory_used, memory_total, memory_usage,
      disk_usage_json, last_reboot_at, last_shutdown_at,
      system_logs_json, response_ms, error_raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    task.id,
    checkedAt,
    snmpResult.result,
    snmpResult.hostname || null,
    snmpResult.uptimeSeconds ?? null,
    snmpResult.cpuUsage ?? null,
    snmpResult.memoryUsed ?? null,
    snmpResult.memoryTotal ?? null,
    snmpResult.memoryUsage ?? null,
    JSON.stringify(filesystems),
    snmpResult.lastRebootAt || null,
    snmpResult.lastShutdownAt || null,
    JSON.stringify(systemLogs),
    snmpResult.responseMs ?? null,
    errorRaw
  );

  db.prepare(`
    UPDATE tasks
    SET snmp_last_checked=?, snmp_last_status=?, snmp_last_error=?, updated_at=?
    WHERE id=?
  `).run(checkedAt, snmpResult.result, errorRaw, checkedAt, task.id);

  if (snmpResult.result === 'FAIL') {
    log(
      'WARN',
      'TASK',
      'scheduler',
      task.id,
      `SNMP check failed for "${task.name}": ${snmpResult.errorRaw || 'Unknown SNMP error'}`,
      null
    );
  }
}

async function processResult(task, agentResult) {
  const checkedAt = nowIso();

  db.prepare(`
    INSERT INTO checks (
      id, task_id, checked_at, result, response_ms, error_raw, endpoint_results
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    task.id,
    checkedAt,
    agentResult.result,
    agentResult.responseMs ?? null,
    agentResult.errorRaw ?? null,
    agentResult.endpointResults ? JSON.stringify(agentResult.endpointResults) : null
  );

  if (agentResult.snmpAttempted && agentResult.snmp) {
    saveSnmpResult(task, agentResult.snmp);
  }

  const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  if (!current || current.deleted_at || current.is_active === 0) return agentResult;

  const previousStatus = current.status || 'OK';
  const previousCfc = current.cfc || 0;
  let newStatus = previousStatus;
  let newCfc = previousCfc;

  if (agentResult.result === 'PASS') {
    newCfc = 0;
    if (previousStatus === 'FAULT') {
      newStatus = 'OK';
      log('INFO', 'TASK', 'scheduler', current.id, `"${current.name}" FAULT to OK`, null);
      await handleRecovery(current);
    }
  } else {
    newCfc = previousCfc + 1;
    const threshold = current.n_threshold || DEFAULT_N;
    if (previousStatus !== 'FAULT' && newCfc >= threshold) {
      newStatus = 'FAULT';
      log(
        'WARN',
        'TASK',
        'scheduler',
        current.id,
        `"${current.name}" OK to FAULT after ${newCfc} consecutive failures`,
        agentResult.errorRaw || null
      );
      await handleFaultStart(current, agentResult.errorRaw);
    }
  }

  db.prepare(`
    UPDATE tasks SET status=?, cfc=?, last_checked=?, updated_at=? WHERE id=?
  `).run(newStatus, newCfc, checkedAt, checkedAt, current.id);

  return { ...agentResult, newStatus, newCfc };
}

async function handleFaultStart(task, errorRaw) {
  const existing = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);
  if (existing) return;

  const currentTime = nowIso();
  db.prepare(`
    INSERT INTO incident_state (id, task_id, t0, was_alerted, alerted_tiers)
    VALUES (?, ?, ?, 0, '')
  `).run(uuidv4(), task.id, currentTime);

  if (!parseBoolean(task.email_enabled)) {
    log('WARN', 'EMAIL', 'scheduler', task.id,
      `L1 skipped because email is disabled for "${task.name}"`, null);
    return;
  }

  const incident = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);
  try {
    const sent = await mailService.sendAlert({
      task,
      incidentState: incident,
      tier: 'L1',
      errorRaw,
    });
    if (sent) {
      db.prepare(`
        UPDATE incident_state
        SET l1_sent_at=?, was_alerted=1, alerted_tiers=?
        WHERE task_id=?
      `).run(currentTime, appendTier(incident.alerted_tiers, 'L1'), task.id);
    }
  } catch (error) {
    log('ERROR', 'EMAIL', 'scheduler', task.id,
      `L1 email failed for "${task.name}": ${error.message}`, error.stack);
  }
}

async function handleRecovery(task) {
  const incident = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);
  if (!incident) return;

  if (parseBoolean(task.email_enabled) && incident.was_alerted) {
    try {
      await mailService.sendAllClear({ task, t0: incident.t0 });
    } catch (error) {
      log('ERROR', 'EMAIL', 'scheduler', task.id,
        `All Clear email failed for "${task.name}": ${error.message}`, error.stack);
    }
  }

  db.prepare('DELETE FROM incident_state WHERE task_id=?').run(task.id);
}

async function runOneScheduledTask(task, currentTime) {
  if (runningTaskIds.has(task.id)) return;
  runningTaskIds.add(task.id);

  try {
    const runSnmpNow = shouldRunSnmp(task, currentTime);
    let runtimeTask = { ...task, run_snmp: runSnmpNow };
    if (runSnmpNow) runtimeTask = addPlainSnmpCredentials(runtimeTask);

    const result = await dispatchAgent(runtimeTask);
    await processResult(task, result);
  } catch (error) {
    log('ERROR', 'SYSTEM', 'scheduler', task.id,
      `Task "${task.name}" execution failed: ${error.message}`, error.stack);
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function runPollCycle() {
  if (pollRunning) {
    log('WARN', 'SYSTEM', 'scheduler', null,
      'Poll cycle skipped because the previous cycle is still running', null);
    return;
  }

  pollRunning = true;
  try {
    const tasks = db.prepare(`
      SELECT * FROM tasks
      WHERE deleted_at IS NULL AND is_active=1
      ORDER BY name
    `).all();
    const currentTime = Date.now();
    const dueTasks = tasks.filter((task) => shouldRunNormalCheck(task, currentTime));
    await Promise.allSettled(
      dueTasks.map((task) => runOneScheduledTask(task, currentTime))
    );
  } finally {
    pollRunning = false;
  }
}

async function sendEscalation(task, incident, tier) {
  try {
    const latestCheck = db.prepare(`
      SELECT error_raw FROM checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 1
    `).get(task.id);

    const sent = await mailService.sendAlert({
      task,
      incidentState: incident,
      tier,
      errorRaw: latestCheck?.error_raw || null,
    });
    if (!sent) return;

    const timestamp = nowIso();
    if (tier === 'L2') {
      db.prepare(`
        UPDATE incident_state SET l2_sent_at=?, alerted_tiers=? WHERE task_id=?
      `).run(timestamp, appendTier(incident.alerted_tiers, 'L2'), task.id);
    } else if (tier === 'L3') {
      db.prepare(`
        UPDATE incident_state
        SET l3_sent_at=?, last_l3_repeat=?, alerted_tiers=?
        WHERE task_id=?
      `).run(timestamp, timestamp, appendTier(incident.alerted_tiers, 'L3'), task.id);
    }
  } catch (error) {
    log('ERROR', 'EMAIL', 'scheduler', task.id,
      `${tier} email failed for "${task.name}": ${error.message}`, error.stack);
  }
}

async function runEscalationCheck() {
  if (escalationRunning) return;
  escalationRunning = true;

  try {
    const rows = db.prepare(`
      SELECT t.*, i.id AS incident_id, i.t0, i.l1_sent_at, i.l2_sent_at,
             i.l3_sent_at, i.last_l3_repeat, i.was_alerted, i.alerted_tiers
      FROM incident_state i
      JOIN tasks t ON t.id=i.task_id
      WHERE t.deleted_at IS NULL AND t.is_active=1 AND t.status='FAULT'
    `).all();

    const currentTime = Date.now();
    for (const row of rows) {
      if (!parseBoolean(row.email_enabled)) continue;

      const incidentStart = new Date(row.t0).getTime();
      if (Number.isNaN(incidentStart)) continue;

      const l2DelayMs = Math.max(1, parseInt(row.l2_delay_min || '2880', 10)) * 60000;
      const l3RepeatMs = Math.max(1, parseInt(row.l3_repeat_min || '2880', 10)) * 60000;
      const incident = {
        id: row.incident_id,
        task_id: row.id,
        t0: row.t0,
        l1_sent_at: row.l1_sent_at,
        l2_sent_at: row.l2_sent_at,
        l3_sent_at: row.l3_sent_at,
        last_l3_repeat: row.last_l3_repeat,
        was_alerted: row.was_alerted,
        alerted_tiers: row.alerted_tiers,
      };

      if (!row.l2_sent_at && currentTime - incidentStart >= l2DelayMs) {
        await sendEscalation(row, incident, 'L2');
        continue;
      }
      if (!row.l2_sent_at) continue;

      const lastEscalation = new Date(
        row.last_l3_repeat || row.l3_sent_at || row.l2_sent_at
      ).getTime();
      if (!Number.isNaN(lastEscalation) &&
          currentTime - lastEscalation >= l3RepeatMs) {
        await sendEscalation(row, incident, 'L3');
      }
    }
  } finally {
    escalationRunning = false;
  }
}

async function manualRun(taskId, actor) {
  const task = db.prepare(`
    SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL
  `).get(taskId);
  if (!task) throw new Error('Task not found');
  if (runningTaskIds.has(task.id)) {
    throw new Error('This task already has a check in progress');
  }

  runningTaskIds.add(task.id);
  try {
    log('INFO', 'TASK', actor, task.id,
      `Manual run triggered for "${task.name}" by ${actor}`, null);

    let runtimeTask = {
      ...task,
      run_snmp: task.type === 'PING' && parseBoolean(task.snmp_enabled),
    };
    if (runtimeTask.run_snmp) runtimeTask = addPlainSnmpCredentials(runtimeTask);

    const result = await dispatchAgent(runtimeTask);
    await processResult(task, result);
    return result;
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function testTask(taskData) {
  const runtimeTask = {
    ...taskData,
    run_snmp: taskData.type === 'PING' && parseBoolean(taskData.snmp_enabled),
  };
  return dispatchAgent(runtimeTask);
}

function pruneHistory() {
  const regularDays = Math.max(1, parseInt(process.env.PRUNE_DAYS || '60', 10));
  const snmpDays = Math.max(1, SNMP_RETENTION_DAYS);
  const regularCutoff = new Date(Date.now() - regularDays * 86400000).toISOString();
  const snmpCutoff = new Date(Date.now() - snmpDays * 86400000).toISOString();

  const checks = db.prepare('DELETE FROM checks WHERE checked_at < ?').run(regularCutoff);
  const snmpChecks = db.prepare('DELETE FROM snmp_checks WHERE checked_at < ?').run(snmpCutoff);
  const appLogs = db.prepare('DELETE FROM app_logs WHERE created_at < ?').run(regularCutoff);
  const auditLogs = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(regularCutoff);

  log('INFO', 'SYSTEM', 'scheduler', null,
    `Pruner removed ${checks.changes} checks, ${snmpChecks.changes} SNMP checks, ` +
    `${appLogs.changes} application logs and ${auditLogs.changes} audit logs`, null);
}

function startSchedulers() {
  if (schedulersStarted) {
    log('WARN', 'SYSTEM', 'system', null,
      'Schedulers already started; duplicate start ignored', null);
    return;
  }
  schedulersStarted = true;

  db.prepare('UPDATE tasks SET interval_min=? WHERE interval_min < ?')
    .run(MIN_INTERVAL_MIN, MIN_INTERVAL_MIN);
  db.prepare('UPDATE tasks SET interval_min=? WHERE interval_min > ?')
    .run(MAX_INTERVAL_MIN, MAX_INTERVAL_MIN);
  db.prepare('UPDATE tasks SET snmp_interval_min=? WHERE snmp_interval_min < ?')
    .run(MIN_SNMP_INTERVAL_MIN, MIN_SNMP_INTERVAL_MIN);
  db.prepare('UPDATE tasks SET snmp_interval_min=? WHERE snmp_interval_min > ?')
    .run(MAX_SNMP_INTERVAL_MIN, MAX_SNMP_INTERVAL_MIN);

  cron.schedule(POLL_CYCLE_CRON, async () => {
    try { await runPollCycle(); }
    catch (error) {
      log('ERROR', 'SYSTEM', 'scheduler', null,
        `Poll cycle failed: ${error.message}`, error.stack);
    }
  });

  cron.schedule('*/1 * * * *', async () => {
    try { await runEscalationCheck(); }
    catch (error) {
      log('ERROR', 'SYSTEM', 'scheduler', null,
        `Escalation cycle failed: ${error.message}`, error.stack);
    }
  });

  cron.schedule('0 0 * * *', () => {
    try { pruneHistory(); }
    catch (error) {
      log('ERROR', 'SYSTEM', 'scheduler', null,
        `History pruning failed: ${error.message}`, error.stack);
    }
  });

  // 23:58 IST equals 18:28 UTC.
  cron.schedule('28 18 * * *', async () => {
    try {
      const { archiveLogs } = require('../controllers/logsController');
      await archiveLogs();
    } catch (error) {
      log('ERROR', 'SYSTEM', 'scheduler', null,
        `Log archive job failed: ${error.message}`, error.stack);
    }
  });

  log('INFO', 'SYSTEM', 'system', null,
    `Schedulers started; poll=${POLL_CYCLE_CRON}, PING interval=` +
    `${MIN_INTERVAL_MIN}-${MAX_INTERVAL_MIN}m, SNMP interval=` +
    `${MIN_SNMP_INTERVAL_MIN}-${MAX_SNMP_INTERVAL_MIN}m, ` +
    `SNMP retention=${SNMP_RETENTION_DAYS} days`, null);
}

module.exports = {
  startSchedulers,
  manualRun,
  testTask,
  runPollCycle,
  runEscalationCheck,
  processResult,
  saveSnmpResult,
  addPlainSnmpCredentials,
  decryptCredential,
};
