// src/agents/webAgent.js — HTTP/HTTPS multi-URL application check
const axios = require('axios');

/**
 * Check a single URL endpoint.
 */
async function checkUrl(urlConfig, defaultTimeout = 15) {
  const url = typeof urlConfig === 'string' ? urlConfig : urlConfig.url;
  const expectedStatus = urlConfig.expected_status || null;
  const keyword = urlConfig.keyword || null;
  const timeout = (urlConfig.timeout_sec || defaultTimeout) * 1000;

  const start = Date.now();
  try {
    const response = await axios.get(url, {
      timeout,
      validateStatus: () => true, // don't throw on any status
      maxRedirects: 5,
      headers: { 'User-Agent': 'NetWatch-Monitor/1.0' },
    });
    const responseMs = Date.now() - start;
    const status = response.status;

    // Status check
    if (expectedStatus) {
      if (status !== parseInt(expectedStatus)) {
        return {
          url, result: 'FAIL', httpStatus: status, responseMs,
          errorRaw: `Expected HTTP ${expectedStatus}, got HTTP ${status}`,
        };
      }
    } else if (status >= 400) {
      return {
        url, result: 'FAIL', httpStatus: status, responseMs,
        errorRaw: `HTTP ${status} — server returned error status`,
      };
    }

    // Keyword check
    if (keyword) {
      const body = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data);
      if (!body.includes(keyword)) {
        return {
          url, result: 'FAIL', httpStatus: status, responseMs,
          errorRaw: `Keyword "${keyword}" not found in response body`,
        };
      }
    }

    return { url, result: 'PASS', httpStatus: status, responseMs, errorRaw: null };
  } catch (err) {
    const responseMs = Date.now() - start;
    let errorRaw = err.message;
    if (err.code === 'ECONNABORTED') errorRaw = `Connection timeout after ${timeout}ms — ${url}`;
    else if (err.code === 'ECONNREFUSED') errorRaw = `Connection refused — ${url}`;
    else if (err.code === 'ENOTFOUND') errorRaw = `DNS resolution failed — ${url}`;
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

  // Check all URLs concurrently
  const results = await Promise.all(urls.map(u => checkUrl(u)));

  const failed = results.filter(r => r.result === 'FAIL');
  const avgMs = Math.round(results.reduce((s, r) => s + (r.responseMs || 0), 0) / results.length);
  const overallResult = failed.length > 0 ? 'FAIL' : 'PASS';

  const errorRaw = failed.length > 0
    ? failed.map(f => `[${f.url}] ${f.errorRaw}`).join('\n')
    : null;

  return {
    result: overallResult,
    responseMs: avgMs,
    errorRaw,
    endpointResults: results,
  };
}

module.exports = { run, checkUrl };
