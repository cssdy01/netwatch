// backend/src/controllers/tasksController.js

const { Router } = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validateTask, parseBoolean } = require('../middleware/validateTask');
const { log, audit } = require('../services/appLog');
const { manualRun } = require('../services/monitoringService');
const pingAgent = require('../agents/pingAgent');
const webAgent = require('../agents/webAgent');

const router = Router();

function getCredentialKey() {
  const secret = String(process.env.SNMP_CREDENTIAL_KEY || '');
  if (secret.length < 32) {
    throw new Error('SNMP_CREDENTIAL_KEY must contain at least 32 characters');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function encryptCredential(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getCredentialKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

function decryptCredential(value) {
  if (!value) return '';
  const parts = String(value).split(':');
  if (parts.length !== 3) throw new Error('Stored SNMP credential format is invalid');
  const [ivHex, tagHex, encryptedHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getCredentialKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sanitizeTask(task) {
  if (!task) return null;
  const result = {
    ...task,
    email_enabled: task.email_enabled === 1,
    is_vm: task.is_vm === 1,
    is_active: task.is_active !== 0,
    host_mapping_enabled: task.host_mapping_enabled === 1,
    snmp_enabled: task.snmp_enabled === 1,
    snmp_community_configured: Boolean(task.snmp_community_enc),
    snmp_auth_password_configured: Boolean(task.snmp_auth_password_enc),
    snmp_priv_password_configured: Boolean(task.snmp_priv_password_enc),
  };
  delete result.snmp_community_enc;
  delete result.snmp_auth_password_enc;
  delete result.snmp_priv_password_enc;
  return result;
}

function sanitizeSnmpCheck(row) {
  if (!row) return null;
  const result = {
    ...row,
    disk_usage: parseJson(row.disk_usage_json, []),
    system_logs: parseJson(row.system_logs_json, []),
  };
  delete result.disk_usage_json;
  delete result.system_logs_json;
  return result;
}

function incidentDuration(incident) {
  if (!incident || !incident.t0) return null;
  const ms = Date.now() - new Date(incident.t0).getTime();
  if (!Number.isFinite(ms)) return null;
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function getSnmpSummary(taskId) {
  const latest = db.prepare(`
    SELECT * FROM snmp_checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 1
  `).get(taskId);
  const lastTen = db.prepare(`
    SELECT * FROM snmp_checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 10
  `).all(taskId);
  const history = db.prepare(`
    SELECT id, checked_at, result, hostname, uptime_seconds, cpu_usage,
           memory_used, memory_total, memory_usage, disk_usage_json,
           last_reboot_at, last_shutdown_at, response_ms, error_raw
    FROM snmp_checks
    WHERE task_id=? AND checked_at >= datetime('now','-15 days')
    ORDER BY checked_at ASC LIMIT 2000
  `).all(taskId);
  return {
    latest: sanitizeSnmpCheck(latest),
    last_10_checks: lastTen.map(sanitizeSnmpCheck),
    chart_15_days: history.map(sanitizeSnmpCheck),
  };
}

function enrichTask(task) {
  const incident = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);
  const lastCheck = db.prepare(`
    SELECT result,response_ms,error_raw,endpoint_results,checked_at
    FROM checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 1
  `).get(task.id);
  return {
    ...sanitizeTask(task),
    last_result: lastCheck?.result || null,
    last_response_ms: lastCheck?.response_ms ?? null,
    last_error_raw: lastCheck?.error_raw || null,
    last_endpoint_results: parseJson(lastCheck?.endpoint_results, null),
    last_checked_at: lastCheck?.checked_at || null,
    incident_duration: incidentDuration(incident),
    t0: incident?.t0 || null,
    incident: incident ? {
      t0: incident.t0,
      l1_sent_at: incident.l1_sent_at,
      l2_sent_at: incident.l2_sent_at,
      l3_sent_at: incident.l3_sent_at,
      alerted_tiers: incident.alerted_tiers,
    } : null,
  };
}

function parseHostMapping(body, type) {
  if (type !== 'APPLICATION') {
    return { enabled: 0, hostname: '', ip: '' };
  }
  const enabled = parseBoolean(body.host_mapping_enabled);
  return {
    enabled: enabled ? 1 : 0,
    hostname: enabled ? String(body.host_mapping_hostname || '').trim() : '',
    ip: enabled ? String(body.host_mapping_ip || '').trim() : '',
  };
}

function defaultSnmpConfig() {
  return {
    enabled: 0, version: '3', port: 161, communityEnc: '', username: '',
    authPasswordEnc: '', privPasswordEnc: '', securityLevel: 'authNoPriv',
    authProtocol: 'SHA', privProtocol: 'NONE', intervalMin: 15,
    timeoutSec: 5, retries: 1, logsOid: '', rebootOid: '', shutdownOid: '',
  };
}

function buildSnmpConfig(body, type, existing = null) {
  if (type !== 'PING') return defaultSnmpConfig();
  const version = String(body.snmp_version || '3').trim();
  const securityLevel = String(body.snmp_security_level || 'authNoPriv').trim();
  let communityEnc = existing?.snmp_community_enc || '';
  let authPasswordEnc = existing?.snmp_auth_password_enc || '';
  let privPasswordEnc = existing?.snmp_priv_password_enc || '';

  if (Object.prototype.hasOwnProperty.call(body, 'snmp_community') && body.snmp_community !== '') {
    communityEnc = encryptCredential(body.snmp_community);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'snmp_auth_password') && body.snmp_auth_password !== '') {
    authPasswordEnc = encryptCredential(body.snmp_auth_password);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'snmp_priv_password') && body.snmp_priv_password !== '') {
    privPasswordEnc = encryptCredential(body.snmp_priv_password);
  }

  if (version === '2c') {
    authPasswordEnc = '';
    privPasswordEnc = '';
  } else {
    communityEnc = '';
  }
  if (securityLevel === 'noAuthNoPriv') {
    authPasswordEnc = '';
    privPasswordEnc = '';
  } else if (securityLevel === 'authNoPriv') {
    privPasswordEnc = '';
  }

  return {
    enabled: parseBoolean(body.snmp_enabled) ? 1 : 0,
    version,
    port: parseInt(body.snmp_port || '161', 10),
    communityEnc,
    username: String(body.snmp_username || '').trim(),
    authPasswordEnc,
    privPasswordEnc,
    securityLevel,
    authProtocol: String(body.snmp_auth_protocol || 'SHA').toUpperCase(),
    privProtocol: String(body.snmp_priv_protocol || 'NONE').toUpperCase(),
    intervalMin: parseInt(body.snmp_interval_min || '15', 10),
    timeoutSec: parseInt(body.snmp_timeout_sec || '5', 10),
    retries: parseInt(body.snmp_retries || '1', 10),
    logsOid: String(body.snmp_extend_logs_oid || '').trim().replace(/^\./, ''),
    rebootOid: String(body.snmp_extend_reboot_oid || '').trim().replace(/^\./, ''),
    shutdownOid: String(body.snmp_extend_shutdown_oid || '').trim().replace(/^\./, ''),
  };
}

function buildSnmpTestTask(body, stored = null) {
  const task = { ...(stored || {}), ...body, type: 'PING', snmp_enabled: true, run_snmp: true };
  if (!task.snmp_community && stored?.snmp_community_enc) {
    task.snmp_community = decryptCredential(stored.snmp_community_enc);
  }
  if (!task.snmp_auth_password && stored?.snmp_auth_password_enc) {
    task.snmp_auth_password = decryptCredential(stored.snmp_auth_password_enc);
  }
  if (!task.snmp_priv_password && stored?.snmp_priv_password_enc) {
    task.snmp_priv_password = decryptCredential(stored.snmp_priv_password_enc);
  }
  return task;
}

// Public routes must be before /:id.
router.get('/public/summary', (_req, res) => {
  const tasks = db.prepare("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY name").all();
  res.json(tasks.map((task) => {
    const checks = db.prepare(`
      SELECT result,response_ms,checked_at FROM checks
      WHERE task_id=? ORDER BY checked_at DESC LIMIT 10
    `).all(task.id);
    const latest = task.snmp_enabled === 1
      ? db.prepare('SELECT * FROM snmp_checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 1').get(task.id)
      : null;
    return {
      id: task.id, name: task.name, type: task.type, target: task.target,
      os_type: task.os_type, status: task.status, is_active: task.is_active !== 0,
      last_checked: task.last_checked, url: task.url,
      expected_status: task.expected_status, timeout_sec: task.timeout_sec,
      checks,
      snmp: {
        enabled: task.snmp_enabled === 1,
        last_status: task.snmp_last_status || null,
        last_checked_at: task.snmp_last_checked || null,
        last_error: task.snmp_last_error || null,
        latest: sanitizeSnmpCheck(latest),
      },
    };
  }));
});

router.get('/public/:id', (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const checks = db.prepare(`
    SELECT result,response_ms,error_raw,endpoint_results,checked_at
    FROM checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 15
  `).all(task.id).map((row) => ({ ...row, endpoint_results: parseJson(row.endpoint_results, null) }));
  const last = checks[0] || null;
  res.json({
    id: task.id, name: task.name, type: task.type, target: task.target,
    os_type: task.os_type, status: task.status, is_active: task.is_active !== 0,
    url: task.url, expected_status: task.expected_status, timeout_sec: task.timeout_sec,
    last_result: last?.result || null, last_response_ms: last?.response_ms ?? null,
    last_error_raw: last?.error_raw || null, last_checked_at: last?.checked_at || null,
    checks,
    snmp: {
      enabled: task.snmp_enabled === 1,
      last_status: task.snmp_last_status || null,
      last_checked_at: task.snmp_last_checked || null,
      last_error: task.snmp_last_error || null,
      ...(task.snmp_enabled === 1 ? getSnmpSummary(task.id) : {
        latest: null, last_10_checks: [], chart_15_days: [],
      }),
    },
  });
});

// Specific authenticated routes must be before /:id.
router.post('/snmp/test', requireAuth, async (req, res) => {
  try {
    let stored = null;
    if (req.body.task_id) {
      stored = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(req.body.task_id);
      if (!stored) return res.status(404).json({ error: 'Task not found' });
      if (stored.type !== 'PING') return res.status(400).json({ error: 'SNMP is available only for System/PING tasks' });
    }
    const testTask = buildSnmpTestTask(req.body, stored);
    if (!testTask.target) return res.status(400).json({ error: 'Target is required' });
    const result = await pingAgent.runSnmp(testTask);
    log(result.result === 'PASS' ? 'INFO' : 'WARN', 'ADMIN', req.user.username,
      stored?.id || null, `SNMP connection test ${result.result.toLowerCase()} for ${testTask.target}`,
      result.errorRaw || null);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'SNMP connection test failed' });
  }
});

router.post('/test', requireAuth, async (req, res) => {
  try {
    if (req.body.type === 'PING') return res.json(await pingAgent.run(req.body));
    if (req.body.type === 'APPLICATION') return res.json(await webAgent.run(req.body));
    return res.status(400).json({ error: 'Type must be PING or APPLICATION' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', requireAuth, (_req, res) => {
  const tasks = db.prepare("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY name").all();
  res.json(tasks.map(enrichTask));
});

router.get('/bin', requireAuth, (_req, res) => {
  const tasks = db.prepare("SELECT * FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all();
  res.json(tasks.map(enrichTask));
});

router.get('/:id/snmp-history', requireAuth, (req, res) => {
  const task = db.prepare("SELECT id,type FROM tasks WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.type !== 'PING') return res.status(400).json({ error: 'SNMP history is available only for System/PING tasks' });
  const days = Math.min(30, Math.max(1, parseInt(req.query.days || '15', 10)));
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit || '500', 10)));
  const history = db.prepare(`
    SELECT * FROM snmp_checks
    WHERE task_id=? AND checked_at >= datetime('now', ?)
    ORDER BY checked_at DESC LIMIT ?
  `).all(task.id, `-${days} days`, limit).map(sanitizeSnmpCheck);
  res.json({ task_id: task.id, history });
});

router.get('/:id', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const checks = db.prepare('SELECT * FROM checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 100')
    .all(task.id).map((row) => ({ ...row, endpoint_results: parseJson(row.endpoint_results, null) }));
  const faultStats = db.prepare(`
    SELECT date(checked_at) AS day, COUNT(*) AS faults FROM checks
    WHERE task_id=? AND result='FAIL' AND checked_at >= datetime('now','-30 days')
    GROUP BY date(checked_at) ORDER BY day
  `).all(task.id);
  res.json({
    ...enrichTask(task), checks, fault_stats: faultStats,
    snmp: {
      enabled: task.snmp_enabled === 1,
      last_status: task.snmp_last_status || null,
      last_checked_at: task.snmp_last_checked || null,
      last_error: task.snmp_last_error || null,
      ...(task.snmp_enabled === 1 ? getSnmpSummary(task.id) : {
        latest: null, last_10_checks: [], chart_15_days: [],
      }),
    },
  });
});

router.post('/', requireAuth, validateTask, (req, res) => {
  try {
    const b = req.body;
    const id = uuidv4();
    const hm = parseHostMapping(b, b.type);
    const s = buildSnmpConfig(b, b.type);
    db.prepare(`
      INSERT INTO tasks (
        id,name,type,target,url,expected_status,timeout_sec,os_type,is_vm,
        interval_min,n_threshold,l2_delay_min,l3_repeat_min,email_l1,email_l2,email_l3,
        email_enabled,is_active,host_mapping_enabled,host_mapping_hostname,host_mapping_ip,
        snmp_enabled,snmp_version,snmp_port,snmp_community_enc,snmp_username,
        snmp_auth_password_enc,snmp_priv_password_enc,snmp_security_level,
        snmp_auth_protocol,snmp_priv_protocol,snmp_interval_min,snmp_timeout_sec,
        snmp_retries,snmp_extend_logs_oid,snmp_extend_reboot_oid,snmp_extend_shutdown_oid
      ) VALUES (${Array(37).fill('?').join(',')})
    `).run(
      id, b.name.trim(), b.type, b.target.trim(), b.url?.trim() || '',
      b.expected_status ? parseInt(b.expected_status, 10) : null,
      parseInt(b.timeout_sec || '15', 10), b.os_type || null, parseBoolean(b.is_vm) ? 1 : 0,
      parseInt(b.interval_min, 10), parseInt(b.n_threshold || '2', 10),
      parseInt(b.l2_delay_min, 10), parseInt(b.l3_repeat_min, 10),
      b.email_l1 || '', b.email_l2 || '', b.email_l3 || '',
      b.email_enabled === false || b.email_enabled === 0 ? 0 : 1,
      b.is_active === false || b.is_active === 0 ? 0 : 1,
      hm.enabled, hm.hostname, hm.ip,
      s.enabled, s.version, s.port, s.communityEnc, s.username, s.authPasswordEnc,
      s.privPasswordEnc, s.securityLevel, s.authProtocol, s.privProtocol,
      s.intervalMin, s.timeoutSec, s.retries, s.logsOid, s.rebootOid, s.shutdownOid
    );
    const created = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    log('INFO', 'ADMIN', req.user.username, id, `Task "${b.name}" created`, null);
    audit(req.user.username, 'TASK_CREATED', `Task: ${b.name}; Type: ${b.type}; SNMP: ${s.enabled ? 'enabled' : 'disabled'}`);
    res.status(201).json(enrichTask(created));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', requireAuth, validateTask, (req, res) => {
  try {
    const existing = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const b = req.body;
    const hm = parseHostMapping(b, b.type);
    const s = buildSnmpConfig(b, b.type, existing);
    db.prepare(`
      UPDATE tasks SET
        name=?,type=?,target=?,url=?,expected_status=?,timeout_sec=?,os_type=?,is_vm=?,
        interval_min=?,n_threshold=?,l2_delay_min=?,l3_repeat_min=?,email_l1=?,email_l2=?,
        email_l3=?,email_enabled=?,is_active=?,host_mapping_enabled=?,host_mapping_hostname=?,
        host_mapping_ip=?,snmp_enabled=?,snmp_version=?,snmp_port=?,snmp_community_enc=?,
        snmp_username=?,snmp_auth_password_enc=?,snmp_priv_password_enc=?,snmp_security_level=?,
        snmp_auth_protocol=?,snmp_priv_protocol=?,snmp_interval_min=?,snmp_timeout_sec=?,
        snmp_retries=?,snmp_extend_logs_oid=?,snmp_extend_reboot_oid=?,snmp_extend_shutdown_oid=?,
        updated_at=datetime('now') WHERE id=?
    `).run(
      b.name.trim(), b.type, b.target.trim(), b.url?.trim() || '',
      b.expected_status ? parseInt(b.expected_status, 10) : null,
      parseInt(b.timeout_sec || '15', 10), b.os_type || null, parseBoolean(b.is_vm) ? 1 : 0,
      parseInt(b.interval_min, 10), parseInt(b.n_threshold || '2', 10),
      parseInt(b.l2_delay_min, 10), parseInt(b.l3_repeat_min, 10),
      b.email_l1 || '', b.email_l2 || '', b.email_l3 || '',
      b.email_enabled === false || b.email_enabled === 0 ? 0 : 1,
      b.is_active === false || b.is_active === 0 ? 0 : 1,
      hm.enabled, hm.hostname, hm.ip,
      s.enabled, s.version, s.port, s.communityEnc, s.username, s.authPasswordEnc,
      s.privPasswordEnc, s.securityLevel, s.authProtocol, s.privProtocol,
      s.intervalMin, s.timeoutSec, s.retries, s.logsOid, s.rebootOid, s.shutdownOid,
      req.params.id
    );
    if (b.is_active === false || b.is_active === 0) {
      db.prepare('DELETE FROM incident_state WHERE task_id=?').run(req.params.id);
      db.prepare("UPDATE tasks SET status='OK',cfc=0 WHERE id=?").run(req.params.id);
    }
    const updated = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    log('INFO', 'ADMIN', req.user.username, req.params.id, `Task "${b.name}" updated`, null);
    audit(req.user.username, 'TASK_UPDATED', `Task: ${b.name}; Type: ${b.type}; SNMP: ${s.enabled ? 'enabled' : 'disabled'}`);
    res.json(enrichTask(updated));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare("UPDATE tasks SET deleted_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(task.id);
  db.prepare('DELETE FROM incident_state WHERE task_id=?').run(task.id);
  log('INFO', 'ADMIN', req.user.username, task.id, `Task "${task.name}" moved to bin`, null);
  res.json({ ok: true });
});

router.post('/:id/restore', requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NOT NULL").get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found in bin' });
  db.prepare("UPDATE tasks SET deleted_at=NULL,updated_at=datetime('now') WHERE id=?").run(task.id);
  res.json({ ok: true });
});

router.delete('/:id/hard', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
  res.json({ ok: true });
});

router.post('/:id/run', requireAuth, async (req, res) => {
  try { res.json(await manualRun(req.params.id, req.user.username)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.patch('/:id/email-toggle', requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const value = task.email_enabled === 1 ? 0 : 1;
  db.prepare("UPDATE tasks SET email_enabled=?,updated_at=datetime('now') WHERE id=?").run(value, task.id);
  res.json({ email_enabled: value === 1 });
});

router.patch('/:id/active-toggle', requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const value = task.is_active === 0 ? 1 : 0;
  db.prepare("UPDATE tasks SET is_active=?,updated_at=datetime('now') WHERE id=?").run(value, task.id);
  if (!value) {
    db.prepare('DELETE FROM incident_state WHERE task_id=?').run(task.id);
    db.prepare("UPDATE tasks SET cfc=0,status='OK' WHERE id=?").run(task.id);
  }
  res.json({ is_active: value === 1 });
});

router.patch('/:id/snmp-toggle', requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.type !== 'PING') return res.status(400).json({ error: 'SNMP is available only for System/PING tasks' });
  const value = task.snmp_enabled === 1 ? 0 : 1;
  if (value === 1) {
    if (task.snmp_version === '2c' && !task.snmp_community_enc) {
      return res.status(400).json({ error: 'Configure an SNMP community before enabling SNMP' });
    }
    if (task.snmp_version === '3' && !task.snmp_username) {
      return res.status(400).json({ error: 'Configure an SNMP username before enabling SNMP' });
    }
    if (task.snmp_version === '3' && task.snmp_security_level !== 'noAuthNoPriv' && !task.snmp_auth_password_enc) {
      return res.status(400).json({ error: 'Configure an SNMP authentication password before enabling SNMP' });
    }
    if (task.snmp_version === '3' && task.snmp_security_level === 'authPriv' && !task.snmp_priv_password_enc) {
      return res.status(400).json({ error: 'Configure an SNMP privacy password before enabling SNMP' });
    }
  }
  db.prepare("UPDATE tasks SET snmp_enabled=?,snmp_last_error=NULL,updated_at=datetime('now') WHERE id=?")
    .run(value, task.id);
  audit(req.user.username, value ? 'SNMP_ENABLED' : 'SNMP_DISABLED', `Task: ${task.name}; Target: ${task.target}`);
  res.json({ snmp_enabled: value === 1 });
});

module.exports = router;
