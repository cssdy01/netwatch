// backend/src/middleware/validateTask.js

const MIN_INTERVAL_MIN = parseInt(
  process.env.MIN_MONITOR_INTERVAL_MIN || '3',
  10
);

const MAX_INTERVAL_MIN = parseInt(
  process.env.MAX_MONITOR_INTERVAL_MIN || '15',
  10
);

const MIN_SNMP_INTERVAL_MIN = parseInt(
  process.env.SNMP_MIN_INTERVAL_MIN || '3',
  10
);

const MAX_SNMP_INTERVAL_MIN = parseInt(
  process.env.SNMP_MAX_INTERVAL_MIN || '1440',
  10
);

const MIN_N_THRESHOLD = 1;
const MAX_N_THRESHOLD = 5;

const VALID_SNMP_VERSIONS = new Set(['2c', '3']);

const VALID_SNMP_SECURITY_LEVELS = new Set([
  'noAuthNoPriv',
  'authNoPriv',
  'authPriv',
]);

const VALID_SNMP_AUTH_PROTOCOLS = new Set([
  'NONE',
  'MD5',
  'SHA',
  'SHA224',
  'SHA256',
  'SHA384',
  'SHA512',
]);

const VALID_SNMP_PRIV_PROTOCOLS = new Set([
  'NONE',
  'DES',
  'AES',
  'AES192',
  'AES256',
]);

function parseBoolean(value) {
  return (
    value === true ||
    value === 1 ||
    value === '1' ||
    value === 'true' ||
    value === 'on' ||
    value === 'yes'
  );
}

function isValidIpv4(ip) {
  if (!ip || typeof ip !== 'string') {
    return false;
  }

  const trimmed = ip.trim();

  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed) &&
    trimmed
      .split('.')
      .every((octet) => {
        const value = Number.parseInt(octet, 10);
        return value >= 0 && value <= 255;
      })
  );
}

function isValidHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') {
    return false;
  }

  const value = hostname.trim();

  if (!value || value.length > 253) {
    return false;
  }

  return value
    .split('.')
    .every((label) => (
      label.length >= 1 &&
      label.length <= 63 &&
      /^?:[a-zA-Z0-9-]*[a-zA-Z0-9]?$/.test(label)
    ));
}

function isValidTarget(target) {
  return isValidIpv4(target) || isValidHostname(target);
}

function isValidOid(oid) {
  if (oid === undefined || oid === null || oid === '') {
    return true;
  }

  if (typeof oid !== 'string') {
    return false;
  }

  const value = oid.trim().replace(/^\./, '');

  return /^\d+(?:\.\d+)+$/.test(value);
}

function isIntegerInRange(value, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);

  return (
    Number.isInteger(parsed) &&
    parsed >= minimum &&
    parsed <= maximum
  );
}

function validateEmails(body) {
  for (const field of ['email_l1', 'email_l2', 'email_l3']) {
    const value = body[field];

    if (!value) {
      continue;
    }

    const emails = String(value)
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean);

    if (emails.length > 5) {
      return `${field}: maximum 5 email addresses per level`;
    }

    for (const email of emails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return `${field}: "${email}" is not a valid email address`;
      }
    }
  }

  return null;
}

function validateSnmp(body, requestMethod) {
  const snmpEnabled = parseBoolean(body.snmp_enabled);

  if (!snmpEnabled) {
    return null;
  }

  if (body.type !== 'PING') {
    return 'SNMP monitoring is available only for System/PING tasks';
  }

  const version = String(body.snmp_version || '3').trim();

  if (!VALID_SNMP_VERSIONS.has(version)) {
    return 'SNMP version must be 2c or 3';
  }

  const port = body.snmp_port ?? 161;

  if (!isIntegerInRange(port, 1, 65535)) {
    return 'SNMP port must be between 1 and 65535';
  }

  const snmpInterval = body.snmp_interval_min ?? 15;

  if (
    !isIntegerInRange(
      snmpInterval,
      MIN_SNMP_INTERVAL_MIN,
      MAX_SNMP_INTERVAL_MIN
    )
  ) {
    return (
      `SNMP interval must be between ` +
      `${MIN_SNMP_INTERVAL_MIN} and ` +
      `${MAX_SNMP_INTERVAL_MIN} minutes`
    );
  }

  const timeout = body.snmp_timeout_sec ?? 5;

  if (!isIntegerInRange(timeout, 1, 60)) {
    return 'SNMP timeout must be between 1 and 60 seconds';
  }

  const retries = body.snmp_retries ?? 1;

  if (!isIntegerInRange(retries, 0, 5)) {
    return 'SNMP retries must be between 0 and 5';
  }

  if (!isValidOid(body.snmp_extend_logs_oid)) {
    return 'SNMP system logs extend OID is invalid';
  }

  if (!isValidOid(body.snmp_extend_reboot_oid)) {
    return 'SNMP reboot extend OID is invalid';
  }

  if (!isValidOid(body.snmp_extend_shutdown_oid)) {
    return 'SNMP shutdown extend OID is invalid';
  }

  if (version === '2c') {
    const community = String(body.snmp_community || '').trim();

    if (requestMethod === 'POST' && !community) {
      return 'SNMP community is required for SNMP v2c';
    }

    if (community.length > 255) {
      return 'SNMP community must not exceed 255 characters';
    }

    return null;
  }

  const username = String(body.snmp_username || '').trim();

  if (!username) {
    return 'SNMP username is required for SNMP v3';
  }

  if (username.length > 64) {
    return 'SNMP username must not exceed 64 characters';
  }

  const securityLevel = String(
    body.snmp_security_level || 'authNoPriv'
  ).trim();

  if (!VALID_SNMP_SECURITY_LEVELS.has(securityLevel)) {
    return (
      'SNMP security level must be ' +
      'noAuthNoPriv, authNoPriv or authPriv'
    );
  }

  const authProtocol = String(
    body.snmp_auth_protocol || 'SHA'
  ).toUpperCase();

  if (!VALID_SNMP_AUTH_PROTOCOLS.has(authProtocol)) {
    return 'Unsupported SNMP authentication protocol';
  }

  const privProtocol = String(
    body.snmp_priv_protocol || 'NONE'
  ).toUpperCase();

  if (!VALID_SNMP_PRIV_PROTOCOLS.has(privProtocol)) {
    return 'Unsupported SNMP privacy protocol';
  }

  const authPassword = String(
    body.snmp_auth_password || ''
  );

  const privPassword = String(
    body.snmp_priv_password || ''
  );

  if (securityLevel === 'noAuthNoPriv') {
    if (authProtocol !== 'NONE') {
      return (
        'Authentication protocol must be NONE ' +
        'when security level is noAuthNoPriv'
      );
    }

    if (privProtocol !== 'NONE') {
      return (
        'Privacy protocol must be NONE ' +
        'when security level is noAuthNoPriv'
      );
    }

    return null;
  }

  if (authProtocol === 'NONE') {
    return (
      'An authentication protocol is required for ' +
      `${securityLevel}`
    );
  }

  // A password is mandatory when creating a new task.
  // During task update, an empty password means keep the stored credential.
  if (requestMethod === 'POST' && !authPassword) {
    return 'SNMP authentication password is required';
  }

  if (authPassword && authPassword.length < 8) {
    return 'SNMP authentication password must contain at least 8 characters';
  }

  if (authPassword.length > 255) {
    return 'SNMP authentication password must not exceed 255 characters';
  }

  if (securityLevel === 'authNoPriv') {
    if (privProtocol !== 'NONE') {
      return (
        'Privacy protocol must be NONE ' +
        'when security level is authNoPriv'
      );
    }

    return null;
  }

  if (privProtocol === 'NONE') {
    return 'A privacy protocol is required for authPriv';
  }

  if (requestMethod === 'POST' && !privPassword) {
    return 'SNMP privacy password is required for authPriv';
  }

  if (privPassword && privPassword.length < 8) {
    return 'SNMP privacy password must contain at least 8 characters';
  }

  if (privPassword.length > 255) {
    return 'SNMP privacy password must not exceed 255 characters';
  }

  return null;
}

function validateTask(req, res, next) {
  const {
    name,
    type,
    target,
    interval_min,
    n_threshold,
    url,
    l2_delay_min,
    l3_repeat_min,
    host_mapping_enabled,
    host_mapping_hostname,
    host_mapping_ip,
  } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({
      error: 'Task name is required',
    });
  }

  if (!['PING', 'APPLICATION'].includes(type)) {
    return res.status(400).json({
      error: 'Type must be PING or APPLICATION',
    });
  }

  if (!target || !String(target).trim()) {
    return res.status(400).json({
      error: 'Target is required',
    });
  }

  if (!isValidTarget(String(target).trim())) {
    return res.status(400).json({
      error: 'Target must be a valid IPv4 address or hostname',
    });
  }

  if (
    !isIntegerInRange(
      interval_min,
      MIN_INTERVAL_MIN,
      MAX_INTERVAL_MIN
    )
  ) {
    return res.status(400).json({
      error:
        `Check interval must be between ` +
        `${MIN_INTERVAL_MIN} and ${MAX_INTERVAL_MIN} minutes`,
    });
  }

  if (
    n_threshold !== undefined &&
    n_threshold !== null &&
    n_threshold !== ''
  ) {
    if (
      !isIntegerInRange(
        n_threshold,
        MIN_N_THRESHOLD,
        MAX_N_THRESHOLD
      )
    ) {
      return res.status(400).json({
        error:
          `N Threshold must be between ` +
          `${MIN_N_THRESHOLD} and ${MAX_N_THRESHOLD}`,
      });
    }
  }

  if (!isIntegerInRange(l2_delay_min, 1, 525600)) {
    return res.status(400).json({
      error: 'L2 Delay must be between 1 and 525600 minutes',
    });
  }

  if (!isIntegerInRange(l3_repeat_min, 1, 525600)) {
    return res.status(400).json({
      error: 'L3 Repeat must be between 1 and 525600 minutes',
    });
  }

  if (type === 'APPLICATION') {
    if (
      !url ||
      typeof url !== 'string' ||
      !/^https?:\/\//i.test(url.trim())
    ) {
      return res.status(400).json({
        error:
          'URL is required and must start with http:// or https://',
      });
    }

    if (parseBoolean(host_mapping_enabled)) {
      const mappingHostname = String(
        host_mapping_hostname || ''
      ).trim();

      const mappingIp = String(
        host_mapping_ip || ''
      ).trim();

      if (!isValidHostname(mappingHostname)) {
        return res.status(400).json({
          error:
            'A valid host mapping hostname is required ' +
            'when host mapping is enabled',
        });
      }

      if (!isValidIpv4(mappingIp)) {
        return res.status(400).json({
          error:
            'A valid IPv4 host mapping address is required ' +
            'when host mapping is enabled',
        });
      }
    }
  }

  if (type !== 'APPLICATION' && parseBoolean(host_mapping_enabled)) {
    return res.status(400).json({
      error: 'Host mapping is available only for Application tasks',
    });
  }

  const emailError = validateEmails(req.body);

  if (emailError) {
    return res.status(400).json({
      error: emailError,
    });
  }

  const snmpError = validateSnmp(req.body, req.method);

  if (snmpError) {
    return res.status(400).json({
      error: snmpError,
    });
  }

  next();
}

module.exports = validateTask;
module.exports.validateTask = validateTask;

module.exports.MIN_INTERVAL_MIN = MIN_INTERVAL_MIN;
module.exports.MAX_INTERVAL_MIN = MAX_INTERVAL_MIN;

module.exports.MIN_SNMP_INTERVAL_MIN =
  MIN_SNMP_INTERVAL_MIN;

module.exports.MAX_SNMP_INTERVAL_MIN =
  MAX_SNMP_INTERVAL_MIN;

module.exports.MIN_N_THRESHOLD = MIN_N_THRESHOLD;
module.exports.MAX_N_THRESHOLD = MAX_N_THRESHOLD;

module.exports.isValidIpv4 = isValidIpv4;
module.exports.isValidHostname = isValidHostname;
module.exports.isValidTarget = isValidTarget;
module.exports.isValidOid = isValidOid;
module.exports.parseBoolean = parseBoolean;