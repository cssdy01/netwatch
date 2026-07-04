// src/agents/webAgent.js
// Phase 3 fix: task-level host mapping replaces global host_mappings table.
//
// ROOT CAUSE of "Invalid IP address: undefined":
//   buildAgentForIp() received `ip = undefined` because:
//   1. The global host_mappings table had no row for the hostname, so
//      hostMappings.get(hostname) returned undefined.
//   2. That undefined was passed straight into the http.Agent lookup callback.
//   3. Node.js net internals threw "Invalid IP address: undefined".
//
// FIX:
//   - Each APPLICATION task now carries its own host mapping fields:
//       host_mapping_enabled  (0|1)
//       host_mapping_hostname (string)
//       host_mapping_ip       (string)
//   - webAgent.run(task) reads these fields from the task row directly.
//   - buildAgentForIp() is only ever called when mappedIp is a valid string.
//   - No global host_mappings table lookup happens at check time.
//   - Direct-IP URLs continue to work unchanged (no mapping applied).

const axios = require('axios');
const https = require('https');
const http  = require('http');

// ── helpers ───────────────────────────────────────────────────────────────────

function parseUrlParts(urlStr) {
  try {
    const u = new URL(urlStr);
    return {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? '443' : '80'),
      protocol: u.protocol,
    };
  } catch {
    return null;
  }
}

/**
 * Build an HTTP/HTTPS agent that dials a specific IP address while letting
 * axios send the original URL (preserving the Host header automatically).
 *
 * IMPORTANT: ip must be a non-empty, valid IPv4 string before calling this.
 * The caller is responsible for that guard — never pass undefined here.
 */
function buildAgentForIp(ip, protocol) {
  // The lookup function overrides DNS resolution for any hostname by always
  // returning the configured IP. Node's net module calls it as:
  //   lookup(hostname, options, callback)
  // We ignore hostname/options and always reply with the mapped IP.
  const lookupFn = (_hostname, _opts, callback) => {
    callback(null, ip, 4); // 4 = AF_INET (IPv4)
  };

  if (protocol === 'https:') {
    return new https.Agent({ lookup: lookupFn, rejectUnauthorized: false });
  }
  return new http.Agent({ lookup: lookupFn });
}

/**
 * Validate an IPv4 address string. Returns true if valid.
 */
function isValidIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip.trim()) &&
    ip.trim().split('.').every(o => parseInt(o) <= 255);
}

// ── single-URL check ──────────────────────────────────────────────────────────

/**
 * Check one URL, optionally using a task-level host mapping.
 *
 * @param {string|object} urlConfig   URL string or { url, expected_status, timeout_sec }
 * @param {number}        defaultTimeout  seconds
 * @param {object|null}   taskMapping  { enabled, hostname, ip } — from the task row
 */
async function checkUrl(urlConfig, defaultTimeout = 15, taskMapping = null) {
  const urlStr         = typeof urlConfig === 'string' ? urlConfig : urlConfig.url;
  const expectedStatus = typeof urlConfig === 'object' ? (urlConfig.expected_status || null) : null;
  const timeoutMs      = ((typeof urlConfig === 'object' ? urlConfig.timeout_sec : null) || defaultTimeout) * 1000;

  const start = Date.now();
  const parts = parseUrlParts(urlStr);

  try {
    const axiosConfig = {
      timeout:        timeoutMs,
      validateStatus: () => true,   // never throw on HTTP status
      maxRedirects:   5,
      headers: { 'User-Agent': 'NetWatch-Monitor/1.0' },
    };

    // Apply task-level host mapping only when:
    //  1. mapping is enabled for this task
    //  2. the IP is a valid IPv4 string
    //  3. the URL's hostname matches the configured mapping hostname
    if (
      taskMapping &&
      taskMapping.enabled &&
      isValidIpv4(taskMapping.ip) &&
      parts &&
      parts.hostname.toLowerCase() === (taskMapping.hostname || '').toLowerCase().trim()
    ) {
      const mappedIp = taskMapping.ip.trim();

      // Axios sends the URL as-is (hostname-based), so the Host header is set
      // automatically by Node. We only override the TCP-layer lookup so the
      // connection goes to the configured IP instead of DNS.
      axiosConfig.httpAgent  = buildAgentForIp(mappedIp, parts.protocol);
      axiosConfig.httpsAgent = buildAgentForIp(mappedIp, parts.protocol);
    }

    const response   = await axios.get(urlStr, axiosConfig);
    const responseMs = Date.now() - start;
    const status     = response.status;

    if (expectedStatus) {
      const expected = parseInt(expectedStatus, 10);
      if (status !== expected) {
        return {
          url: urlStr, result: 'FAIL', httpStatus: status, responseMs,
          errorRaw: `HTTP status mismatch — expected ${expected}, received ${status}`,
        };
      }
    } else if (status >= 400) {
      return {
        url: urlStr, result: 'FAIL', httpStatus: status, responseMs,
        errorRaw: `HTTP ${status} — server returned an error status`,
      };
    }

    return { url: urlStr, result: 'PASS', httpStatus: status, responseMs, errorRaw: null };

  } catch (err) {
    const responseMs = Date.now() - start;
    const mapInfo    = (taskMapping && taskMapping.enabled && taskMapping.ip)
      ? ` (mapped to ${taskMapping.ip.trim()})`
      : '';

    let errorRaw = err.message;

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      errorRaw = `Connection timeout after ${timeoutMs}ms — host did not respond in time${mapInfo} (${urlStr})`;
    } else if (err.code === 'ECONNREFUSED') {
      errorRaw = `Connection refused — port closed or service not running${mapInfo} (${urlStr})`;
    } else if (err.code === 'ENOTFOUND') {
      if (taskMapping && taskMapping.enabled) {
        errorRaw = `Host unreachable — mapping is enabled but IP ${taskMapping.ip} did not respond for ${urlStr}`;
      } else {
        errorRaw = `DNS resolution failed — hostname not found for ${urlStr}. Enable hostname mapping in the task if this is a private hostname.`;
      }
    } else if (err.code === 'EHOSTUNREACH') {
      errorRaw = `Host unreachable — check network route${mapInfo} (${urlStr})`;
    } else if (err.code === 'ECONNRESET') {
      errorRaw = `Connection reset by server${mapInfo} (${urlStr})`;
    }

    return { url: urlStr, result: 'FAIL', httpStatus: null, responseMs, errorRaw };
  }
}

// ── main entry point ──────────────────────────────────────────────────────────

/**
 * Run all URLs for an APPLICATION task.
 * Reads host mapping directly from the task row (no global table lookup).
 */
async function run(task) {
  let urls = [];
  try {
    urls = JSON.parse(task.urls || '[]');
  } catch {
    return {
      result: 'FAIL', responseMs: 0,
      errorRaw: 'Invalid URLs configuration — JSON parse error',
      endpointResults: null,
    };
  }

  if (!urls.length) {
    return {
      result: 'FAIL', responseMs: 0,
      errorRaw: 'No URLs configured for this application task',
      endpointResults: null,
    };
  }

  // Build the task-level mapping object (safe: never undefined)
  const taskMapping = {
    enabled:  !!task.host_mapping_enabled,
    hostname: task.host_mapping_hostname || '',
    ip:       task.host_mapping_ip       || '',
  };

  // Validate mapping config if enabled — give a clear error early
  if (taskMapping.enabled) {
    if (!taskMapping.hostname) {
      return {
        result: 'FAIL', responseMs: 0,
        errorRaw: 'Host mapping is enabled but no hostname is configured. Edit the task to add a hostname.',
        endpointResults: null,
      };
    }
    if (!isValidIpv4(taskMapping.ip)) {
      return {
        result: 'FAIL', responseMs: 0,
        errorRaw: `Host mapping is enabled but the IP address "${taskMapping.ip}" is invalid or missing. Edit the task to fix it.`,
        endpointResults: null,
      };
    }
  }

  // Check all URLs concurrently
  const results = await Promise.all(
    urls.map(u => checkUrl(u, 15, taskMapping.enabled ? taskMapping : null))
  );

  const failed  = results.filter(r => r.result === 'FAIL');
  const avgMs   = Math.round(results.reduce((s, r) => s + (r.responseMs || 0), 0) / results.length);
  const overall = failed.length > 0 ? 'FAIL' : 'PASS';

  return {
    result:          overall,
    responseMs:      avgMs,
    errorRaw:        failed.length ? failed.map(f => `[${f.url}] ${f.errorRaw}`).join('\n') : null,
    endpointResults: results,
  };
}

module.exports = { run, checkUrl };
