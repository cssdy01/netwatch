// src/agents/webAgent.js — HTTP/HTTPS multi-URL application check
// Phase 1 changes:
//   - Host mapping support: resolves hostnames to IPs via host_mappings table
//     without modifying /etc/hosts in the container
//   - Keyword checking removed (legacy field ignored for backward compatibility)
//   - Clearer DNS / connection / timeout / status-code error messages
//   - expected_status and timeout_sec per URL entry

const axios = require('axios');
const https = require('https');
const http = require('http');
const db = require('../db');

// ── Host mapping helpers ────────────────────────────────────────────────────

/**
 * Load all host mappings from DB and return as a Map<hostname, ip>
 */
function loadHostMappings() {
  const rows = db.prepare('SELECT hostname, ip_address FROM host_mappings').all();
  const map = new Map();
  for (const r of rows) {
    map.set(r.hostname.toLowerCase(), r.ip_address);
  }
  return map;
}

/**
 * Parse hostname and port from a URL string.
 * Returns { hostname, port, protocol }
 */
function parseUrlParts(urlStr) {
  try {
    const u = new URL(urlStr);
    return {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      protocol: u.protocol,
      pathname: u.pathname + u.search,
    };
  } catch {
    return null;
  }
}

/**
 * Build a custom HTTP/HTTPS agent that connects to a specific IP
 * while preserving the original Host header (for virtual hosting).
 */
function buildAgentForIp(ip, protocol, port) {
  const opts = {
    // Force connection to the mapped IP
    lookup: (hostname, opts, callback) => {
      callback(null, ip, 4); // IPv4
    },
  };

  if (protocol === 'https:') {
    // Allow self-signed certs on private network hosts
    return new https.Agent({ ...opts, rejectUnauthorized: false });
  }
  return new http.Agent(opts);
}

// ── URL checker ─────────────────────────────────────────────────────────────

/**
 * Check a single URL endpoint with optional host mapping.
 * @param {string|object} urlConfig
 * @param {number} defaultTimeout  seconds
 * @param {Map} hostMappings       hostname -> ip from host_mappings table
 */
async function checkUrl(urlConfig, defaultTimeout = 15, hostMappings = new Map()) {
  const url         = typeof urlConfig === 'string' ? urlConfig : urlConfig.url;
  const expectedStatus = urlConfig.expected_status || null;
  // Keyword field intentionally ignored (backward-compat: data preserved, not evaluated)
  const timeout     = (urlConfig.timeout_sec || defaultTimeout) * 1000;

  const start = Date.now();
  const parts = parseUrlParts(url);

  try {
    const axiosConfig = {
      timeout,
      validateStatus: () => true, // don't throw on any HTTP status
      maxRedirects: 5,
      headers: {
        'User-Agent': 'NetWatch-Monitor/1.0',
      },
    };

    // Apply host mapping if this hostname has a configured IP override
    if (parts) {
      const mappedIp = hostMappings.get(parts.hostname.toLowerCase());
      if (mappedIp) {
        // Set the Host header explicitly so the server recognises the virtual hostname
        axiosConfig.headers['Host'] = parts.port && parts.port !== '80' && parts.port !== '443'
          ? `${parts.hostname}:${parts.port}`
          : parts.hostname;
        axiosConfig.httpAgent  = buildAgentForIp(mappedIp, parts.protocol, parts.port);
        axiosConfig.httpsAgent = buildAgentForIp(mappedIp, parts.protocol, parts.port);
      }
    }

    const response = await axios.get(url, axiosConfig);
    const responseMs = Date.now() - start;
    const status = response.status;

    if (expectedStatus) {
      const expected = parseInt(expectedStatus, 10);
      if (status !== expected) {
        return {
          url, result: 'FAIL', httpStatus: status, responseMs,
          errorRaw: `HTTP status mismatch — expected ${expected}, received ${status}`,
        };
      }
    } else if (status >= 400) {
      return {
        url, result: 'FAIL', httpStatus: status, responseMs,
        errorRaw: `HTTP ${status} — server returned an error status`,
      };
    }

    return { url, result: 'PASS', httpStatus: status, responseMs, errorRaw: null };

  } catch (err) {
    const responseMs = Date.now() - start;
    let errorRaw = err.message;

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      errorRaw = `Connection timeout after ${timeout}ms — host did not respond in time (${url})`;
    } else if (err.code === 'ECONNREFUSED') {
      errorRaw = `Connection refused — port closed or service down (${url})`;
    } else if (err.code === 'ENOTFOUND') {
      // For mapped hosts, give a more helpful message
      if (parts && hostMappings.has(parts.hostname.toLowerCase())) {
        errorRaw = `DNS/host mapping failed — configured IP for ${parts.hostname} was unreachable (${url})`;
      } else {
        errorRaw = `DNS resolution failed — hostname not found (${url}). Add a host mapping in Settings if this is a private hostname.`;
      }
    } else if (err.code === 'EHOSTUNREACH') {
      errorRaw = `Host unreachable — check network connectivity (${url})`;
    } else if (err.code === 'ECONNRESET') {
      errorRaw = `Connection reset by server (${url})`;
    }

    return { url, result: 'FAIL', httpStatus: null, responseMs, errorRaw };
  }
}

/**
 * Run all URLs for an APPLICATION task.
 * @returns {{ result, responseMs, errorRaw, endpointResults }}
 */
async function run(task) {
  let urls = [];
  try {
    urls = JSON.parse(task.urls || '[]');
  } catch {
    return {
      result: 'FAIL',
      responseMs: 0,
      errorRaw: 'Invalid URLs configuration — JSON parse error',
      endpointResults: null,
    };
  }

  if (urls.length === 0) {
    return {
      result: 'FAIL',
      responseMs: 0,
      errorRaw: 'No URLs configured for this application task',
      endpointResults: null,
    };
  }

  // Load host mappings once per run
  let hostMappings = new Map();
  try {
    hostMappings = loadHostMappings();
  } catch (err) {
    console.warn('[WebAgent] Could not load host mappings:', err.message);
  }

  // Check all URLs concurrently
  const results = await Promise.all(urls.map(u => checkUrl(u, 15, hostMappings)));

  const failed   = results.filter(r => r.result === 'FAIL');
  const avgMs    = Math.round(results.reduce((s, r) => s + (r.responseMs || 0), 0) / results.length);
  const overall  = failed.length > 0 ? 'FAIL' : 'PASS';

  const errorRaw = failed.length > 0
    ? failed.map(f => `[${f.url}] ${f.errorRaw}`).join('\n')
    : null;

  return {
    result:          overall,
    responseMs:      avgMs,
    errorRaw,
    endpointResults: results,
  };
}

module.exports = { run, checkUrl };