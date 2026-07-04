// src/middleware/validateTask.js — Phase 3
// Added validation for host_mapping_enabled / hostname / ip fields.

const MIN_INTERVAL_MIN = 3;
const MAX_INTERVAL_MIN = 15;
const MIN_N_THRESHOLD  = 1;
const MAX_N_THRESHOLD  = 5;

function isValidIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip.trim()) &&
    ip.trim().split('.').every(o => parseInt(o) <= 255);
}

function validateTask(req, res, next) {
  const {
    name, type, target, interval_min, n_threshold, urls,
    host_mapping_enabled, host_mapping_hostname, host_mapping_ip,
  } = req.body;

  if (!name || !name.trim())
    return res.status(400).json({ error: 'Task name is required' });

  if (!type || !['PING', 'APPLICATION'].includes(type))
    return res.status(400).json({ error: 'Type must be PING or APPLICATION' });

  if (!target || !target.trim())
    return res.status(400).json({ error: 'Target is required' });

  const intervalNum = parseInt(interval_min, 10);
  if (Number.isNaN(intervalNum) || intervalNum < MIN_INTERVAL_MIN || intervalNum > MAX_INTERVAL_MIN)
    return res.status(400).json({
      error: `Check interval must be between ${MIN_INTERVAL_MIN} and ${MAX_INTERVAL_MIN} minutes`,
    });

  if (n_threshold !== undefined && n_threshold !== null && n_threshold !== '') {
    const nNum = parseInt(n_threshold, 10);
    if (Number.isNaN(nNum) || nNum < MIN_N_THRESHOLD || nNum > MAX_N_THRESHOLD)
      return res.status(400).json({
        error: `N Threshold must be between ${MIN_N_THRESHOLD} and ${MAX_N_THRESHOLD}`,
      });
  }

  if (type === 'APPLICATION') {
    // URL list validation
    let parsedUrls = urls;
    if (typeof urls === 'string') {
      try { parsedUrls = JSON.parse(urls); }
      catch { return res.status(400).json({ error: 'URLs must be valid JSON' }); }
    }
    if (!Array.isArray(parsedUrls) || parsedUrls.length === 0)
      return res.status(400).json({ error: 'At least one URL is required for APPLICATION tasks' });

    for (let i = 0; i < parsedUrls.length; i++) {
      const entry  = parsedUrls[i];
      const urlStr = typeof entry === 'string' ? entry : entry?.url;
      if (!urlStr || typeof urlStr !== 'string' || !urlStr.startsWith('http'))
        return res.status(400).json({ error: `URL at index ${i} is invalid — must start with http or https` });
      if (entry?.expected_status != null) {
        const sc = parseInt(entry.expected_status, 10);
        if (Number.isNaN(sc) || sc < 100 || sc > 599)
          return res.status(400).json({ error: `URL at index ${i}: expected_status must be 100–599` });
      }
      if (entry?.timeout_sec != null) {
        const ts = parseInt(entry.timeout_sec, 10);
        if (Number.isNaN(ts) || ts < 1 || ts > 120)
          return res.status(400).json({ error: `URL at index ${i}: timeout_sec must be 1–120` });
      }
    }

    // Host mapping validation (only when enabled)
    const mappingOn = host_mapping_enabled === true ||
                      host_mapping_enabled === 1    ||
                      host_mapping_enabled === '1'  ||
                      host_mapping_enabled === 'true';

    if (mappingOn) {
      if (!host_mapping_hostname || !String(host_mapping_hostname).trim())
        return res.status(400).json({ error: 'Host mapping: hostname is required when mapping is enabled' });

      if (!host_mapping_ip || !String(host_mapping_ip).trim())
        return res.status(400).json({ error: 'Host mapping: IP address is required when mapping is enabled' });

      if (!isValidIpv4(String(host_mapping_ip)))
        return res.status(400).json({ error: `Host mapping: "${host_mapping_ip}" is not a valid IPv4 address` });
    }
  }

  // Email address validation
  for (const field of ['email_l1', 'email_l2', 'email_l3']) {
    const val = req.body[field];
    if (!val) continue;
    const emails = val.split(',').map(e => e.trim()).filter(Boolean);
    if (emails.length > 3)
      return res.status(400).json({ error: `${field}: maximum 3 email addresses per level` });
    for (const e of emails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
        return res.status(400).json({ error: `${field}: "${e}" is not a valid email address` });
    }
  }

  next();
}

module.exports = validateTask;
module.exports.validateTask    = validateTask;
module.exports.MIN_INTERVAL_MIN = MIN_INTERVAL_MIN;
module.exports.MAX_INTERVAL_MIN = MAX_INTERVAL_MIN;
module.exports.MIN_N_THRESHOLD  = MIN_N_THRESHOLD;
module.exports.MAX_N_THRESHOLD  = MAX_N_THRESHOLD;
module.exports.isValidIpv4      = isValidIpv4;
