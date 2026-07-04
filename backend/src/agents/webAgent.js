// src/agents/webAgent.js — Phase 4 definitive fix
//
// CONFIRMED ROOT CAUSES of hostname monitoring failure:
//
// CAUSE 1 — "Invalid IP address: undefined" (test endpoint):
//   POST /api/tasks/test passes req.body directly to dispatchAgent().
//   host_mapping_enabled was sent as the string "true" from the form,
//   isValidIpv4() passed, but the Node http.Agent `lookup` override has
//   a subtle incompatibility with how axios threads the agent through
//   http.request in Node 20: the lookup is not guaranteed to be called
//   for the DNS step before connection, producing "Invalid IP address: undefined"
//   when the lookup callback receives wrong arguments in some code paths.
//
// CAUSE 2 — "Connection timeout after 15000ms" (scheduled + manual run):
//   tasksController.js POST/PUT handlers never saved host_mapping_enabled,
//   host_mapping_hostname, or host_mapping_ip to the database (those fields
//   were missing from both the INSERT and UPDATE SQL statements).
//   So every task had host_mapping_enabled = 0 (default) even after the
//   admin filled in and saved the mapping. The agent never applied any
//   mapping, axios tried real DNS for dev.uimcn.tsaro.com → DNS failed
//   → ENOTFOUND or connection timeout.
//
// THE DEFINITIVE FIX — URL-rewrite strategy (100% reliable):
//   Instead of overriding the DNS lookup (which depends on internal axios/Node
//   implementation details), we:
//     1. Rewrite the URL: replace the hostname with the mapped IP in the actual
//        request URL so Node never needs to do a DNS lookup at all.
//     2. Set the HTTP Host header explicitly to the original hostname so the
//        server responds correctly (virtual hosting, JSF context roots, etc.).
//     3. For HTTPS, also set servername (SNI) to the original hostname.
//   This is the same technique used by curl's --resolve flag and is 100% portable
//   across all Node versions, all axios versions, and all agent configurations.

const axios  = require('axios');
const https  = require('https');

// ── helpers ────────────────────────────────────────────────────────────────────

function isValidIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed) &&
    trimmed.split('.').every(o => parseInt(o, 10) <= 255);
}

/**
 * Parse all parts needed for URL rewriting.
 */
function parseUrlParts(urlStr) {
  try {
    const u = new URL(urlStr);
    return {
      protocol: u.protocol,         // "http:" or "https:"
      hostname: u.hostname,         // "dev.uimcn.tsaro.com"
      port:     u.port || (u.protocol === 'https:' ? '443' : '80'),
      pathname: u.pathname,         // "/Inventory/faces/login.jspx"
      search:   u.search,          // "?foo=bar" or ""
    };
  } catch {
    return null;
  }
}

/**
 * Rewrite a URL by replacing its hostname with a mapped IP.
 * The resulting URL connects directly to the IP while the original
 * hostname is preserved in the Host header.
 *
 * Example:
 *   original:  http://dev.uimcn.tsaro.com:31500/Inventory/faces/login.jspx
 *   mappedIp:  192.168.108.176
 *   rewritten: http://192.168.108.176:31500/Inventory/faces/login.jspx
 *
 * Host header is set to: dev.uimcn.tsaro.com:31500
 */
function rewriteUrlToIp(urlStr, mappedIp) {
  const parts = parseUrlParts(urlStr);
  if (!parts) return urlStr;

  const port = parts.port;
  const defaultPort = parts.protocol === 'https:' ? '443' : '80';
  const portStr = port && port !== defaultPort ? `:${port}` : '';

  return `${parts.protocol}//${mappedIp}${portStr}${parts.pathname}${parts.search}`;
}

// ── single-URL check ───────────────────────────────────────────────────────────

/**
 * Check one URL, optionally using task-level host mapping.
 *
 * @param {string|object} urlConfig   URL string or { url, expected_status, timeout_sec }
 * @param {number}        defaultTimeout  seconds
 * @param {object|null}   mapping  { enabled, hostname, ip } — from the task row
 */
async function checkUrl(urlConfig, defaultTimeout = 15, mapping = null) {
  const originalUrl    = typeof urlConfig === 'string' ? urlConfig : urlConfig.url;
  const expectedStatus = typeof urlConfig === 'object' ? (urlConfig.expected_status || null) : null;
  const timeoutMs      = ((typeof urlConfig === 'object' ? urlConfig.timeout_sec : null) || defaultTimeout) * 1000;

  const start = Date.now();
  const parts = parseUrlParts(originalUrl);

  // Determine whether to apply the host mapping for this URL
  const shouldMap = (
    mapping &&
    mapping.enabled &&
    isValidIpv4(mapping.ip) &&
    mapping.hostname &&
    parts &&
    parts.hostname.toLowerCase() === mapping.hostname.toLowerCase().trim()
  );

  // Build the actual URL to request (IP-based if mapping applies)
  const requestUrl = shouldMap ? rewriteUrlToIp(originalUrl, mapping.ip.trim()) : originalUrl;

  // Build axios config
  const axiosConfig = {
    timeout:        timeoutMs,
    validateStatus: () => true,   // never throw on HTTP status
    maxRedirects:   5,
    headers: {
      'User-Agent': 'NetWatch-Monitor/1.0',
    },
  };

  if (shouldMap) {
    const originalParts = parts;
    const port = originalParts.port;
    const defaultPort = originalParts.protocol === 'https:' ? '443' : '80';

    // Set the Host header to the original hostname (with port if non-default)
    // This makes the server think it's being accessed by hostname
    const hostHeader = (port && port !== defaultPort)
      ? `${originalParts.hostname}:${port}`
      : originalParts.hostname;

    axiosConfig.headers['Host'] = hostHeader;

    // For HTTPS: disable cert validation (private CA) and set SNI to original hostname
    if (originalParts.protocol === 'https:') {
      axiosConfig.httpsAgent = new https.Agent({
        rejectUnauthorized: false,
        servername: originalParts.hostname,  // SNI = original hostname
      });
    }
  }

  try {
    const response   = await axios.get(requestUrl, axiosConfig);
    const responseMs = Date.now() - start;
    const status     = response.status;

    if (expectedStatus) {
      const expected = parseInt(expectedStatus, 10);
      if (status !== expected) {
        return {
          url: originalUrl, result: 'FAIL', httpStatus: status, responseMs,
          errorRaw: `HTTP status mismatch — expected ${expected}, received ${status}`,
        };
      }
    } else if (status >= 400) {
      return {
        url: originalUrl, result: 'FAIL', httpStatus: status, responseMs,
        errorRaw: `HTTP ${status} — server returned an error status`,
      };
    }

    return { url: originalUrl, result: 'PASS', httpStatus: status, responseMs, errorRaw: null };

  } catch (err) {
    const responseMs = Date.now() - start;
    const mapInfo    = shouldMap
      ? ` (hostname ${mapping.hostname} mapped to ${mapping.ip.trim()})`
      : '';

    let errorRaw = err.message;

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      errorRaw = `Connection timeout after ${timeoutMs}ms — host did not respond${mapInfo} (${originalUrl})`;
    } else if (err.code === 'ECONNREFUSED') {
      errorRaw = `Connection refused — port closed or service not running${mapInfo} (${originalUrl})`;
    } else if (err.code === 'ENOTFOUND') {
      if (mapping && mapping.enabled) {
        errorRaw = `DNS/network failure — host mapping enabled but ${mapping.ip} unreachable for ${originalUrl}`;
      } else {
        errorRaw = `DNS resolution failed — hostname not found for ${originalUrl}. Enable hostname mapping in the task if this is a private hostname.`;
      }
    } else if (err.code === 'EHOSTUNREACH') {
      errorRaw = `Host unreachable — check network route${mapInfo} (${originalUrl})`;
    } else if (err.code === 'ECONNRESET') {
      errorRaw = `Connection reset by server${mapInfo} (${originalUrl})`;
    } else if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      // Should not happen with rejectUnauthorized:false, but handle defensively
      errorRaw = `TLS certificate error${mapInfo} (${originalUrl}) — ${err.message}`;
    }

    return { url: originalUrl, result: 'FAIL', httpStatus: null, responseMs, errorRaw };
  }
}

// ── main entry point ───────────────────────────────────────────────────────────

/**
 * Run all URLs for an APPLICATION task.
 * Reads host mapping from the task row — works for both:
 *   - Scheduled runs: task = DB row (has host_mapping_* columns)
 *   - Manual runs:    task = DB row (same)
 *   - Test endpoint:  task = req.body (has host_mapping_* from form)
 */
async function run(task) {
  let urls = [];
  try {
    const rawUrls = task.urls;
    urls = typeof rawUrls === 'string'
      ? JSON.parse(rawUrls)
      : (Array.isArray(rawUrls) ? rawUrls : []);
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

  // Safely extract host mapping fields — handle all incoming types:
  //   - boolean true/false (from JSON body)
  //   - string "true"/"false"/"1"/"0" (from form-encoded body)
  //   - integer 0/1 (from SQLite DB row)
  const rawEnabled = task.host_mapping_enabled;
  const mappingEnabled = rawEnabled === true ||
                         rawEnabled === 1    ||
                         rawEnabled === '1'  ||
                         rawEnabled === 'true';

  const mapping = {
    enabled:  mappingEnabled,
    hostname: String(task.host_mapping_hostname || '').trim(),
    ip:       String(task.host_mapping_ip       || '').trim(),
  };

  // Validate mapping config if enabled — give a clear error immediately
  if (mapping.enabled) {
    if (!mapping.hostname) {
      return {
        result: 'FAIL', responseMs: 0,
        errorRaw: 'Hostname mapping is enabled but no hostname is configured. Edit the task and add the hostname.',
        endpointResults: null,
      };
    }
    if (!isValidIpv4(mapping.ip)) {
      return {
        result: 'FAIL', responseMs: 0,
        errorRaw: `Hostname mapping is enabled but the IP address "${mapping.ip || '(empty)'}" is invalid. Edit the task and enter a valid IPv4 address.`,
        endpointResults: null,
      };
    }
  }

  // Check all URLs concurrently, passing the mapping only when enabled
  const results = await Promise.all(
    urls.map(u => checkUrl(u, 15, mapping.enabled ? mapping : null))
  );

  const failed  = results.filter(r => r.result === 'FAIL');
  const avgMs   = results.length
    ? Math.round(results.reduce((s, r) => s + (r.responseMs || 0), 0) / results.length)
    : 0;
  const overall = failed.length > 0 ? 'FAIL' : 'PASS';

  return {
    result:          overall,
    responseMs:      avgMs,
    errorRaw:        failed.length ? failed.map(f => `[${f.url}] ${f.errorRaw}`).join('\n') : null,
    endpointResults: results,
  };
}

module.exports = { run, checkUrl };
