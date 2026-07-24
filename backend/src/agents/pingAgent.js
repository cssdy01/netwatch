// backend/src/agents/pingAgent.js
//
// System monitoring agent:
//   1. Performs the existing ICMP ping check.
//   2. Optionally performs SNMP polling for PING/System tasks.
//   3. Keeps ICMP as the availability result.
//   4. Reports SNMP failures separately without marking the host down.
//
// Supported SNMP metrics:
//   - Hostname
//   - System uptime
//   - CPU usage
//   - Physical memory usage
//   - Filesystem/disk usage
//   - Optional Net-SNMP extend OIDs:
//       * Last reboot timestamp
//       * Last shutdown timestamp
//       * Most recent system log entries
//
// Plain SNMP credentials must be supplied to this agent by the controller or
// monitoring service as:
//   task.snmp_community
//   task.snmp_auth_password
//   task.snmp_priv_password
//
// Encrypted database fields must never be used directly by this agent.

const { execFile } = require('child_process');
const os = require('os');
const snmp = require('net-snmp');

const IS_WINDOWS = os.platform() === 'win32';

const OIDS = Object.freeze({
  SYS_UPTIME: '1.3.6.1.2.1.1.3.0',
  SYS_NAME: '1.3.6.1.2.1.1.5.0',

  HR_PROCESSOR_LOAD: '1.3.6.1.2.1.25.3.3.1.2',

  HR_STORAGE_TYPE: '1.3.6.1.2.1.25.2.3.1.2',
  HR_STORAGE_DESCRIPTION: '1.3.6.1.2.1.25.2.3.1.3',
  HR_STORAGE_ALLOCATION_UNITS: '1.3.6.1.2.1.25.2.3.1.4',
  HR_STORAGE_SIZE: '1.3.6.1.2.1.25.2.3.1.5',
  HR_STORAGE_USED: '1.3.6.1.2.1.25.2.3.1.6',
});

const STORAGE_TYPES = Object.freeze({
  OTHER: '1.3.6.1.2.1.25.2.1.1',
  RAM: '1.3.6.1.2.1.25.2.1.2',
  VIRTUAL_MEMORY: '1.3.6.1.2.1.25.2.1.3',
  FIXED_DISK: '1.3.6.1.2.1.25.2.1.4',
  REMOVABLE_DISK: '1.3.6.1.2.1.25.2.1.5',
  FLOPPY_DISK: '1.3.6.1.2.1.25.2.1.6',
  COMPACT_DISC: '1.3.6.1.2.1.25.2.1.7',
  RAM_DISK: '1.3.6.1.2.1.25.2.1.8',
  FLASH_MEMORY: '1.3.6.1.2.1.25.2.1.9',
  NETWORK_DISK: '1.3.6.1.2.1.25.2.1.10',
});

const MAX_SYSTEM_LOG_ENTRIES = 500;
const MAX_LOG_ENTRY_LENGTH = 4000;
const MAX_EXTEND_OUTPUT_LENGTH = 2 * 1024 * 1024;

function parseBoolean(value) {
  return (
    value === true ||
    value === 1 ||
    value === '1' ||
    value === 'true' ||
    value === 'yes' ||
    value === 'on'
  );
}

function normalizeOid(oid) {
  return String(oid || '')
    .trim()
    .replace(/^\./, '');
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundToTwo(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function safeInteger(value) {
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }

  if (Buffer.isBuffer(value)) {
    const parsed = Number.parseInt(value.toString('utf8').trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const converted = Number(value);
  return Number.isFinite(converted) ? Math.trunc(converted) : null;
}

function safeText(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').replace(/\0/g, '').trim();
  }

  if (Array.isArray(value)) {
    return value.map((part) => safeText(part)).join('.').trim();
  }

  return String(value).replace(/\0/g, '').trim();
}

function safeOidValue(value) {
  if (Array.isArray(value)) {
    return value.map((part) => String(part)).join('.');
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').replace(/\0/g, '').trim();
  }

  return String(value || '').trim();
}

function sanitizeTarget(target) {
  const safe = String(target || '').trim();

  if (!safe) {
    throw new Error('Target is required');
  }

  // Allow IPv4, IPv6, and DNS hostname characters only.
  if (!/^[a-zA-Z0-9.:-]+$/.test(safe)) {
    throw new Error('Target contains unsupported characters');
  }

  if (safe.length > 253) {
    throw new Error('Target is too long');
  }

  return safe;
}

function parseResponseMs(output) {
  const text = String(output || '');

  const match = text.match(
    /(?:time|temps)[=<]\s*(\d+(?:\.\d+)?)\s*ms/i
  );

  if (!match) {
    return null;
  }

  return Math.max(0, Math.round(Number.parseFloat(match[1])));
}

function runIcmpPing(task) {
  return new Promise((resolve) => {
    let target;

    try {
      target = sanitizeTarget(task.target);
    } catch (error) {
      resolve({
        result: 'FAIL',
        responseMs: 0,
        errorRaw: `Ping configuration error: ${error.message}`,
        endpointResults: null,
      });
      return;
    }

    const timeoutSeconds = clamp(
      Number.parseInt(task.timeout_sec || '5', 10) || 5,
      1,
      60
    );

    let command;
    let args;

    if (IS_WINDOWS) {
      command = 'ping';
      args = [
        '-n',
        '1',
        '-w',
        String(timeoutSeconds * 1000),
        target,
      ];
    } else {
      command = 'ping';
      args = [
        '-c',
        '1',
        '-W',
        String(timeoutSeconds),
        target,
      ];
    }

    const startedAt = Date.now();

    execFile(
      command,
      args,
      {
        timeout: (timeoutSeconds + 2) * 1000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const elapsed = Date.now() - startedAt;
        const responseMs = parseResponseMs(stdout);

        if (!error) {
          resolve({
            result: 'PASS',
            responseMs:
              responseMs === null ? elapsed : responseMs,
            errorRaw: null,
            endpointResults: null,
          });
          return;
        }

        const rawError = [
          stderr,
          stdout,
          error.message,
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join('\n')
          .slice(0, 8000);

        resolve({
          result: 'FAIL',
          responseMs: responseMs === null ? elapsed : responseMs,
          errorRaw: rawError || `Ping failed for ${target}`,
          endpointResults: null,
        });
      }
    );
  });
}

function getSnmpAuthProtocol(protocol) {
  const value = String(protocol || 'SHA').toUpperCase();

  const protocols = {
    NONE: snmp.AuthProtocols.none,
    MD5: snmp.AuthProtocols.md5,
    SHA: snmp.AuthProtocols.sha,
    SHA224: snmp.AuthProtocols.sha224,
    SHA256: snmp.AuthProtocols.sha256,
    SHA384: snmp.AuthProtocols.sha384,
    SHA512: snmp.AuthProtocols.sha512,
  };

  const selected = protocols[value];

  if (selected === undefined) {
    throw new Error(`Unsupported SNMP auth protocol: ${value}`);
  }

  return selected;
}

function getSnmpPrivProtocol(protocol) {
  const value = String(protocol || 'NONE').toUpperCase();

  const protocols = {
    NONE: snmp.PrivProtocols.none,
    DES: snmp.PrivProtocols.des,
    AES: snmp.PrivProtocols.aes,
    AES192: snmp.PrivProtocols.aes192b,
    AES256: snmp.PrivProtocols.aes256b,
  };

  const selected = protocols[value];

  if (selected === undefined) {
    throw new Error(`Unsupported SNMP privacy protocol: ${value}`);
  }

  return selected;
}

function getSnmpSecurityLevel(level) {
  const value = String(level || 'authNoPriv');

  const levels = {
    noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
    authNoPriv: snmp.SecurityLevel.authNoPriv,
    authPriv: snmp.SecurityLevel.authPriv,
  };

  const selected = levels[value];

  if (selected === undefined) {
    throw new Error(`Unsupported SNMP security level: ${value}`);
  }

  return selected;
}

function createSnmpSession(task) {
  const target = sanitizeTarget(task.target);
  const version = String(task.snmp_version || '3').trim();

  const port = clamp(
    Number.parseInt(task.snmp_port || '161', 10) || 161,
    1,
    65535
  );

  const timeoutMs =
    clamp(
      Number.parseInt(task.snmp_timeout_sec || '5', 10) || 5,
      1,
      60
    ) * 1000;

  const retries = clamp(
    Number.parseInt(task.snmp_retries || '1', 10) || 0,
    0,
    5
  );

  const commonOptions = {
    port,
    retries,
    timeout: timeoutMs,
    backoff: 1.0,
    transport: 'udp4',
    trapPort: 162,
    idBitsSize: 32,
  };

  if (version === '2c') {
    const community = String(task.snmp_community || '').trim();

    if (!community) {
      throw new Error('SNMP v2c community is not configured');
    }

    return snmp.createSession(target, community, {
      ...commonOptions,
      version: snmp.Version2c,
    });
  }

  if (version !== '3') {
    throw new Error(`Unsupported SNMP version: ${version}`);
  }

  const username = String(task.snmp_username || '').trim();

  if (!username) {
    throw new Error('SNMP v3 username is not configured');
  }

  const securityLevel = String(
    task.snmp_security_level || 'authNoPriv'
  );

  const user = {
    name: username,
    level: getSnmpSecurityLevel(securityLevel),
  };

  if (
    securityLevel === 'authNoPriv' ||
    securityLevel === 'authPriv'
  ) {
    const authPassword = String(
      task.snmp_auth_password || ''
    );

    if (!authPassword) {
      throw new Error(
        'SNMP v3 authentication password is not configured'
      );
    }

    user.authProtocol = getSnmpAuthProtocol(
      task.snmp_auth_protocol || 'SHA'
    );
    user.authKey = authPassword;
  }

  if (securityLevel === 'authPriv') {
    const privPassword = String(
      task.snmp_priv_password || ''
    );

    if (!privPassword) {
      throw new Error(
        'SNMP v3 privacy password is not configured'
      );
    }

    user.privProtocol = getSnmpPrivProtocol(
      task.snmp_priv_protocol || 'AES'
    );
    user.privKey = privPassword;
  }

  return snmp.createV3Session(target, user, commonOptions);
}

function getValues(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) {
        reject(error);
        return;
      }

      const result = {};

      for (const varbind of varbinds || []) {
        const oid = normalizeOid(varbind.oid);

        if (snmp.isVarbindError(varbind)) {
          result[oid] = {
            ok: false,
            error: snmp.varbindError(varbind),
            value: null,
          };
        } else {
          result[oid] = {
            ok: true,
            error: null,
            value: varbind.value,
          };
        }
      }

      resolve(result);
    });
  });
}

function walkSubtree(session, oid) {
  return new Promise((resolve, reject) => {
    const rows = [];

    function feed(varbinds) {
      for (const varbind of varbinds || []) {
        if (snmp.isVarbindError(varbind)) {
          continue;
        }

        rows.push({
          oid: normalizeOid(varbind.oid),
          value: varbind.value,
        });
      }
    }

    session.subtree(
      normalizeOid(oid),
      20,
      feed,
      (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(rows);
      }
    );
  });
}

function extractOidIndex(oid, baseOid) {
  const normalizedOid = normalizeOid(oid);
  const normalizedBase = normalizeOid(baseOid);

  if (!normalizedOid.startsWith(`${normalizedBase}.`)) {
    return null;
  }

  return normalizedOid.slice(normalizedBase.length + 1);
}

function rowsToIndexMap(rows, baseOid, converter = safeText) {
  const map = new Map();

  for (const row of rows || []) {
    const index = extractOidIndex(row.oid, baseOid);

    if (!index) {
      continue;
    }

    map.set(index, converter(row.value));
  }

  return map;
}

async function collectCpuUsage(session) {
  const rows = await walkSubtree(
    session,
    OIDS.HR_PROCESSOR_LOAD
  );

  const loads = rows
    .map((row) => safeInteger(row.value))
    .filter((value) => (
      value !== null &&
      value >= 0 &&
      value <= 100
    ));

  if (loads.length === 0) {
    return null;
  }

  const total = loads.reduce((sum, value) => sum + value, 0);

  return roundToTwo(total / loads.length);
}

function isPhysicalMemory(description, typeOid) {
  const text = String(description || '').toLowerCase();

  if (normalizeOid(typeOid) === STORAGE_TYPES.RAM) {
    return true;
  }

  return (
    text === 'physical memory' ||
    text.includes('physical memory') ||
    text.includes('real memory')
  );
}

function isFilesystem(description, typeOid) {
  const text = String(description || '').toLowerCase();
  const normalizedType = normalizeOid(typeOid);

  if (
    normalizedType === STORAGE_TYPES.FIXED_DISK ||
    normalizedType === STORAGE_TYPES.REMOVABLE_DISK ||
    normalizedType === STORAGE_TYPES.COMPACT_DISC ||
    normalizedType === STORAGE_TYPES.FLASH_MEMORY ||
    normalizedType === STORAGE_TYPES.NETWORK_DISK
  ) {
    return true;
  }

  const excludedDescriptions = [
    'physical memory',
    'real memory',
    'virtual memory',
    'swap',
    'memory buffers',
    'cached memory',
    'shared memory',
  ];

  if (
    excludedDescriptions.some((item) => text.includes(item))
  ) {
    return false;
  }

  return (
    text.startsWith('/') ||
    /^[a-z]:\\/i.test(String(description || '')) ||
    text.includes('filesystem') ||
    text.includes('disk')
  );
}

async function collectStorageMetrics(session) {
  const [
    typeRows,
    descriptionRows,
    allocationRows,
    sizeRows,
    usedRows,
  ] = await Promise.all([
    walkSubtree(session, OIDS.HR_STORAGE_TYPE),
    walkSubtree(session, OIDS.HR_STORAGE_DESCRIPTION),
    walkSubtree(session, OIDS.HR_STORAGE_ALLOCATION_UNITS),
    walkSubtree(session, OIDS.HR_STORAGE_SIZE),
    walkSubtree(session, OIDS.HR_STORAGE_USED),
  ]);

  const typeMap = rowsToIndexMap(
    typeRows,
    OIDS.HR_STORAGE_TYPE,
    safeOidValue
  );

  const descriptionMap = rowsToIndexMap(
    descriptionRows,
    OIDS.HR_STORAGE_DESCRIPTION,
    safeText
  );

  const allocationMap = rowsToIndexMap(
    allocationRows,
    OIDS.HR_STORAGE_ALLOCATION_UNITS,
    safeInteger
  );

  const sizeMap = rowsToIndexMap(
    sizeRows,
    OIDS.HR_STORAGE_SIZE,
    safeInteger
  );

  const usedMap = rowsToIndexMap(
    usedRows,
    OIDS.HR_STORAGE_USED,
    safeInteger
  );

  const indexes = new Set([
    ...descriptionMap.keys(),
    ...allocationMap.keys(),
    ...sizeMap.keys(),
    ...usedMap.keys(),
  ]);

  let memory = null;
  const filesystems = [];

  for (const index of indexes) {
    const description =
      descriptionMap.get(index) || `Storage ${index}`;

    const typeOid = typeMap.get(index) || '';
    const allocationUnits = allocationMap.get(index);
    const sizeUnits = sizeMap.get(index);
    const usedUnits = usedMap.get(index);

    if (
      allocationUnits === null ||
      allocationUnits === undefined ||
      sizeUnits === null ||
      sizeUnits === undefined ||
      usedUnits === null ||
      usedUnits === undefined ||
      allocationUnits <= 0 ||
      sizeUnits <= 0 ||
      usedUnits < 0
    ) {
      continue;
    }

    const totalBytes = sizeUnits * allocationUnits;
    const usedBytes = usedUnits * allocationUnits;

    if (
      !Number.isFinite(totalBytes) ||
      !Number.isFinite(usedBytes) ||
      totalBytes <= 0
    ) {
      continue;
    }

    const usage = roundToTwo(
      clamp((usedBytes / totalBytes) * 100, 0, 100)
    );

    if (isPhysicalMemory(description, typeOid)) {
      if (!memory || totalBytes > memory.total) {
        memory = {
          used: Math.round(usedBytes),
          total: Math.round(totalBytes),
          usage,
        };
      }

      continue;
    }

    if (!isFilesystem(description, typeOid)) {
      continue;
    }

    filesystems.push({
      index,
      name: description,
      type_oid: normalizeOid(typeOid),
      used: Math.round(usedBytes),
      total: Math.round(totalBytes),
      free: Math.max(
        0,
        Math.round(totalBytes - usedBytes)
      ),
      usage,
    });
  }

  filesystems.sort((left, right) => {
    const leftUsage = left.usage === null ? -1 : left.usage;
    const rightUsage = right.usage === null ? -1 : right.usage;

    return rightUsage - leftUsage;
  });

  return {
    memory,
    filesystems,
  };
}

async function getOptionalExtendValue(session, oid) {
  const normalizedOid = normalizeOid(oid);

  if (!normalizedOid) {
    return {
      configured: false,
      available: false,
      value: null,
      error: null,
    };
  }

  try {
    const values = await getValues(session, [normalizedOid]);
    const item = values[normalizedOid];

    if (!item || !item.ok) {
      return {
        configured: true,
        available: false,
        value: null,
        error:
          item?.error || 'No value returned for extend OID',
      };
    }

    const value = safeText(item.value).slice(
      0,
      MAX_EXTEND_OUTPUT_LENGTH
    );

    return {
      configured: true,
      available: true,
      value,
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      value: null,
      error: error.message,
    };
  }
}

function parseSystemLogs(rawValue) {
  if (!rawValue) {
    return [];
  }

  return String(rawValue)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-MAX_SYSTEM_LOG_ENTRIES)
    .map((line) => line.slice(0, MAX_LOG_ENTRY_LENGTH));
}

function parseDiagnosticTimestamp(rawValue) {
  const value = String(rawValue || '').trim();

  if (!value) {
    return null;
  }

  // Unix timestamp in seconds.
  if (/^\d{10}$/.test(value)) {
    const date = new Date(Number(value) * 1000);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  // Unix timestamp in milliseconds.
  if (/^\d{13}$/.test(value)) {
    const date = new Date(Number(value));

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  // ISO or another JavaScript-readable date representation.
  const parsedDate = new Date(value);

  if (!Number.isNaN(parsedDate.getTime())) {
    return parsedDate.toISOString();
  }

  // Preserve the extend output when it is not a recognized timestamp.
  return value.slice(0, 500);
}

async function runSnmp(task) {
  const startedAt = Date.now();
  let session = null;

  try {
    session = createSnmpSession(task);

    // First request verifies connectivity and authentication.
    const baseValues = await getValues(session, [
      OIDS.SYS_NAME,
      OIDS.SYS_UPTIME,
    ]);

    const hostnameItem = baseValues[OIDS.SYS_NAME];
    const uptimeItem = baseValues[OIDS.SYS_UPTIME];

    if (!hostnameItem?.ok && !uptimeItem?.ok) {
      const baseErrors = [
        hostnameItem?.error,
        uptimeItem?.error,
      ]
        .filter(Boolean)
        .join('; ');

      throw new Error(
        baseErrors ||
          'SNMP connected but returned no standard system values'
      );
    }

    const hostname = hostnameItem?.ok
      ? safeText(hostnameItem.value)
      : '';

    const uptimeTicks = uptimeItem?.ok
      ? safeInteger(uptimeItem.value)
      : null;

    const uptimeSeconds =
      uptimeTicks === null
        ? null
        : Math.max(0, Math.floor(uptimeTicks / 100));

    const metricWarnings = [];

    let cpuUsage = null;

    try {
      cpuUsage = await collectCpuUsage(session);

      if (cpuUsage === null) {
        metricWarnings.push(
          'CPU OID returned no usable processor values'
        );
      }
    } catch (error) {
      metricWarnings.push(`CPU: ${error.message}`);
    }

    let storage = {
      memory: null,
      filesystems: [],
    };

    try {
      storage = await collectStorageMetrics(session);

      if (!storage.memory) {
        metricWarnings.push(
          'Physical memory storage entry was not found'
        );
      }

      if (storage.filesystems.length === 0) {
        metricWarnings.push(
          'Filesystem storage entries were not found'
        );
      }
    } catch (error) {
      metricWarnings.push(`Storage: ${error.message}`);
    }

    const [
      rebootDiagnostic,
      shutdownDiagnostic,
      logsDiagnostic,
    ] = await Promise.all([
      getOptionalExtendValue(
        session,
        task.snmp_extend_reboot_oid
      ),
      getOptionalExtendValue(
        session,
        task.snmp_extend_shutdown_oid
      ),
      getOptionalExtendValue(
        session,
        task.snmp_extend_logs_oid
      ),
    ]);

    const diagnosticWarnings = [];

    for (const [name, diagnostic] of [
      ['Reboot extend', rebootDiagnostic],
      ['Shutdown extend', shutdownDiagnostic],
      ['System logs extend', logsDiagnostic],
    ]) {
      if (
        diagnostic.configured &&
        !diagnostic.available &&
        diagnostic.error
      ) {
        diagnosticWarnings.push(
          `${name}: ${diagnostic.error}`
        );
      }
    }

    return {
      result: 'PASS',
      responseMs: Date.now() - startedAt,
      errorRaw: null,

      hostname: hostname || null,
      uptimeSeconds,

      cpuUsage,

      memoryUsed: storage.memory?.used ?? null,
      memoryTotal: storage.memory?.total ?? null,
      memoryUsage: storage.memory?.usage ?? null,

      filesystems: storage.filesystems,

      lastRebootAt: parseDiagnosticTimestamp(
        rebootDiagnostic.value
      ),

      lastShutdownAt: parseDiagnosticTimestamp(
        shutdownDiagnostic.value
      ),

      systemLogs: parseSystemLogs(logsDiagnostic.value),

      diagnostics: {
        reboot: rebootDiagnostic,
        shutdown: shutdownDiagnostic,
        logs: {
          configured: logsDiagnostic.configured,
          available: logsDiagnostic.available,
          error: logsDiagnostic.error,
          count: parseSystemLogs(logsDiagnostic.value).length,
        },
      },

      warnings: [
        ...metricWarnings,
        ...diagnosticWarnings,
      ],
    };
  } catch (error) {
    return {
      result: 'FAIL',
      responseMs: Date.now() - startedAt,
      errorRaw: String(
        error?.message || 'Unknown SNMP polling failure'
      ).slice(0, 8000),

      hostname: null,
      uptimeSeconds: null,

      cpuUsage: null,

      memoryUsed: null,
      memoryTotal: null,
      memoryUsage: null,

      filesystems: [],

      lastRebootAt: null,
      lastShutdownAt: null,
      systemLogs: [],

      diagnostics: {
        reboot: {
          configured: Boolean(
            normalizeOid(task.snmp_extend_reboot_oid)
          ),
          available: false,
          error: null,
        },
        shutdown: {
          configured: Boolean(
            normalizeOid(task.snmp_extend_shutdown_oid)
          ),
          available: false,
          error: null,
        },
        logs: {
          configured: Boolean(
            normalizeOid(task.snmp_extend_logs_oid)
          ),
          available: false,
          error: null,
          count: 0,
        },
      },

      warnings: [],
    };
  } finally {
    if (session) {
      try {
        session.close();
      } catch {
        // Session cleanup failure must not change the monitoring result.
      }
    }
  }
}

async function run(task) {
  const pingResult = await runIcmpPing(task);

  const snmpEnabled =
    task.type === 'PING' &&
    parseBoolean(task.snmp_enabled);

  const shouldRunSnmp =
    snmpEnabled &&
    task.run_snmp !== false &&
    task.run_snmp !== 0 &&
    task.run_snmp !== '0' &&
    task.run_snmp !== 'false';

  let snmpResult = null;

  if (shouldRunSnmp) {
    snmpResult = await runSnmp(task);
  }

  // ICMP remains the availability source.
  // An SNMP failure does not turn a reachable system into a FAULT.
  return {
    result: pingResult.result,
    responseMs: pingResult.responseMs,
    errorRaw: pingResult.errorRaw,
    endpointResults: pingResult.endpointResults,

    snmpEnabled,
    snmpAttempted: shouldRunSnmp,
    snmp: snmpResult,
  };
}

module.exports = {
  run,
  runIcmpPing,
  runSnmp,
  createSnmpSession,
  parseSystemLogs,
  parseDiagnosticTimestamp,
  OIDS,
};