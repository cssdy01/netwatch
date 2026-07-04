// src/mail/transport.js
// Phase 5: HTML email support via multipart/alternative MIME through sendmail/Postfix.
// No SMTP credentials. No Nodemailer. No external relay changes.
// Sends using /usr/sbin/sendmail -i -t (reads full RFC 2822 message from stdin).
// Falls back to mailx plain-text pipe if sendmail is unavailable.

const { execSync, spawn } = require('child_process');

const MONITOR_HOST = () => process.env.MONITOR_HOST || 'netwatch';
const FROM_NAME   = () => process.env.MAIL_FROM_NAME  || 'NetWatch Monitor';
const FROM_EMAIL  = () => process.env.MAIL_FROM_EMAIL || `alerts@${MONITOR_HOST()}.local`;

// ── Binary detection ──────────────────────────────────────────────────────────

function detectSendmail() {
  const candidates = ['/usr/sbin/sendmail', '/usr/lib/sendmail', '/sbin/sendmail'];
  for (const c of candidates) {
    try {
      execSync(`test -x ${c}`, { stdio: 'pipe', shell: true });
      console.log(`[NetWatch Mail] sendmail binary: ${c}`);
      return c;
    } catch (_) {}
  }
  return null;
}

function detectMailBin() {
  const candidates = [
    '/usr/bin/mail', '/usr/bin/mailx', '/usr/bin/bsd-mailx', '/bin/mail', 'mail', 'mailx',
  ];
  for (const c of candidates) {
    try {
      if (c.startsWith('/')) {
        execSync(`test -x ${c}`, { stdio: 'pipe', shell: true });
        console.log(`[NetWatch Mail] mail binary fallback: ${c}`);
        return c;
      }
      const found = execSync(`command -v ${c} 2>/dev/null`, { stdio: 'pipe', shell: true })
        .toString().trim();
      if (found) { console.log(`[NetWatch Mail] mail binary fallback: ${found}`); return found; }
    } catch (_) {}
  }
  console.warn('[NetWatch Mail] WARNING: no sendmail or mail/mailx binary found. Rebuild image.');
  return null;
}

const SENDMAIL_BIN = detectSendmail();
const MAIL_BIN     = detectMailBin();

// ── Sanitisation ──────────────────────────────────────────────────────────────

function sanitiseSubject(s) {
  return String(s || '[NETWATCH] Notification').replace(/[\r\n]+/g, ' ').trim();
}

function sanitiseHeader(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim();
}

function normaliseRecipients(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(',');
  return [...new Set(list.map(x => String(x).trim()).filter(Boolean))];
}

/** Escape a value for safe insertion into HTML */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── IST timestamp ─────────────────────────────────────────────────────────────

function nowIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }) + ' IST';
}

function toIST(utcStr) {
  if (!utcStr) return '—';
  return new Date(utcStr).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }) + ' IST';
}

// ── Plain-text builders ───────────────────────────────────────────────────────

function getUrlsText(task) {
  if (task.type !== 'APPLICATION') return null;
  try {
    const urls = JSON.parse(task.urls || '[]');
    if (!urls.length) return null;
    return urls.map(u => (typeof u === 'string' ? u : u.url)).join('\n             ');
  } catch { return null; }
}

const TIER_LABEL = {
  L1: 'L1 - Initial fault',
  L2: 'L2 - Escalation (open 48h)',
  L3: 'L3 - Repeated escalation',
};

function buildAlertPlainText({ task, t0, tier, errorRaw }) {
  const typeLabel = task.type === 'PING' ? 'Ping / ICMP' : 'Application';
  const urlsText  = getUrlsText(task);
  return `Hello Team,

NetWatch detected an issue.

Task           : ${task.name}
Type           : ${typeLabel}
System IP      : ${task.target}${urlsText ? `\nURL            : ${urlsText}` : ''}
Alert          : ${TIER_LABEL[tier] || tier}
Incident Start : ${toIST(t0)}

Error:
${errorRaw || 'No error details captured'}

Regards,
NetWatch Monitor | ${MONITOR_HOST()}
`;
}

function buildAllClearPlainText({ task, downtimeDuration }) {
  const typeLabel = task.type === 'PING' ? 'Ping / ICMP' : 'Application';
  return `Hello Team,

NetWatch detected recovery.

Task      : ${task.name}
Type      : ${typeLabel}
System IP : ${task.target}
Recovered : ${nowIST()}
Downtime  : ${downtimeDuration}

Status:
Service is back online.

Regards,
NetWatch Monitor | ${MONITOR_HOST()}
`;
}

function buildTestPlainText() {
  return `Hello,

NetWatch mail configuration test.

Monitor Host : ${MONITOR_HOST()}
Mail Method  : sendmail / Postfix local relay
Relay        : ${process.env.POSTFIX_RELAY || '172.17.0.1:25'}
Sent At      : ${nowIST()}

Status:
Mail configuration is working correctly.

Regards,
NetWatch Monitor | ${MONITOR_HOST()}
`;
}

// ── HTML template system ──────────────────────────────────────────────────────

// Theme colours — one per alert type
const THEME = {
  red:    { bg: '#c0392b', light: '#fdf2f2', border: '#e74c3c' },
  orange: { bg: '#d35400', light: '#fdf6f0', border: '#e67e22' },
  green:  { bg: '#1e8449', light: '#f0faf3', border: '#27ae60' },
  blue:   { bg: '#1a5276', light: '#eaf2fb', border: '#2980b9' },
};

/**
 * Wrap content in the base email shell: white card, coloured header strip,
 * simple table body, footer. Outlook-compatible (table layout, inline CSS).
 */
function baseHtml({ colour, headerTitle, headerSub, bodyRows, errorBox, statusBox }) {
  const t   = THEME[colour] || THEME.blue;
  const mon = esc(MONITOR_HOST());

  const rowsHtml = (bodyRows || []).map(([label, value]) => `
        <tr>
          <td style="padding:6px 12px 6px 0;width:130px;color:#555555;font-size:13px;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
          <td style="padding:6px 0;color:#111111;font-size:13px;vertical-align:top;word-break:break-all;">${value}</td>
        </tr>`).join('');

  const errorHtml = errorBox ? `
      <div style="margin-top:18px;">
        <p style="margin:0 0 6px 0;font-size:12px;color:#555555;font-weight:bold;text-transform:uppercase;letter-spacing:.5px;">Error Details</p>
        <div style="background:#fdf2f2;border-left:3px solid #c0392b;padding:10px 12px;font-family:Courier New,Courier,monospace;font-size:12px;color:#7b241c;white-space:pre-wrap;word-break:break-all;border-radius:2px;">${esc(errorBox)}</div>
      </div>` : '';

  const statusHtml = statusBox ? `
      <div style="margin-top:18px;background:${t.light};border:1px solid ${t.border};padding:10px 14px;border-radius:3px;font-size:13px;color:#333333;">${esc(statusBox)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(headerTitle)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f4;padding:20px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #dddddd;border-radius:4px;overflow:hidden;">

      <!-- Header strip -->
      <tr><td style="background:${t.bg};padding:16px 20px;">
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.75);letter-spacing:1px;text-transform:uppercase;font-weight:bold;">NetWatch Monitor</p>
        <p style="margin:4px 0 0 0;font-size:18px;color:#ffffff;font-weight:bold;">${esc(headerTitle)}</p>
        <p style="margin:4px 0 0 0;font-size:12px;color:rgba(255,255,255,0.85);">${esc(headerSub)}</p>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:20px 24px 24px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${rowsHtml}
        </table>
        ${errorHtml}
        ${statusHtml}
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:12px 24px;border-top:1px solid #eeeeee;background:#fafafa;">
        <p style="margin:0;font-size:11px;color:#888888;">Regards,&nbsp; <strong style="color:#555555;">NetWatch Monitor</strong> | ${mon}</p>
        <p style="margin:4px 0 0 0;font-size:10px;color:#bbbbbb;">This is an automated notification. Do not reply to this email.</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── HTML builders (one per email type) ───────────────────────────────────────

function getUrlsHtml(task) {
  if (task.type !== 'APPLICATION') return null;
  try {
    const urls = JSON.parse(task.urls || '[]');
    if (!urls.length) return null;
    return urls.map(u => `<span style="word-break:break-all;">${esc(typeof u === 'string' ? u : u.url)}</span>`).join('<br>');
  } catch { return null; }
}

function buildAlertHtml({ task, t0, tier, errorRaw }) {
  const colour     = tier === 'L1' ? 'red' : 'orange';
  const tierLabels = { L1: 'ALERT - DOWN', L2: 'ESCALATION - DOWN', L3: 'ESCALATION - DOWN' };
  const tierSubs   = {
    L1: 'Initial fault detected',
    L2: 'Still open after 48 hours',
    L3: 'Repeated 48h escalation',
  };
  const typeLabel = task.type === 'PING' ? 'Ping / ICMP' : 'Application';
  const urlsHtml  = getUrlsHtml(task);

  const rows = [
    ['Task',           esc(task.name)],
    ['Type',           esc(typeLabel)],
    ['System IP',      esc(task.target)],
    ...(urlsHtml ? [['URL', urlsHtml]] : []),
    ['Alert',          esc(TIER_LABEL[tier] || tier)],
    ['Incident Start', esc(toIST(t0))],
  ];

  return baseHtml({
    colour,
    headerTitle: `NETWATCH ${tierLabels[tier] || 'ALERT'}`,
    headerSub:   tierSubs[tier] || '',
    bodyRows:    rows,
    errorBox:    errorRaw || 'No error details captured',
  });
}

function buildAllClearHtml({ task, downtimeDuration }) {
  const typeLabel = task.type === 'PING' ? 'Ping / ICMP' : 'Application';
  return baseHtml({
    colour:      'green',
    headerTitle: 'NETWATCH ALL CLEAR',
    headerSub:   'Service has recovered',
    bodyRows: [
      ['Task',      esc(task.name)],
      ['Type',      esc(typeLabel)],
      ['System IP', esc(task.target)],
      ['Recovered', esc(nowIST())],
      ['Downtime',  esc(downtimeDuration)],
    ],
    statusBox: 'Service is back online.',
  });
}

function buildTestHtml() {
  return baseHtml({
    colour:      'blue',
    headerTitle: 'NETWATCH MAIL TEST',
    headerSub:   'Mail configuration check',
    bodyRows: [
      ['Monitor Host', esc(MONITOR_HOST())],
      ['Mail Method',  'sendmail / Postfix local relay'],
      ['Relay',        esc(process.env.POSTFIX_RELAY || '172.17.0.1:25')],
      ['Sent At',      esc(nowIST())],
    ],
    statusBox: 'Mail configuration is working correctly.',
  });
}

// ── MIME multipart/alternative builder ────────────────────────────────────────

const BOUNDARY_PREFIX = 'NW_MIME';

function buildMimeMessage({ to, subject, plainText, html, fromName, fromEmail }) {
  const recipients = normaliseRecipients(to);
  const safeSubject = sanitiseSubject(subject);
  const safeFrom    = `${sanitiseHeader(fromName)} <${sanitiseHeader(fromEmail)}>`;
  const boundary    = `${BOUNDARY_PREFIX}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Base64-encode the HTML part to handle special chars cleanly
  const htmlB64 = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n').trim();

  return [
    `From: ${safeFrom}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plainText.replace(/\r\n/g, '\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64,
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

// ── Send function ─────────────────────────────────────────────────────────────

/**
 * Primary: pipe full MIME message into sendmail -i -t
 * Fallback: pipe plain-text body into mailx -s subject recipients
 */
function sendViaSendmail({ mimeMessage }) {
  return new Promise((resolve, reject) => {
    const child = spawn(SENDMAIL_BIN, ['-i', '-t'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`sendmail exited ${code}${stderr ? ': ' + stderr.trim() : ''}`));
    });
    child.stdin.write(mimeMessage);
    child.stdin.end();
  });
}

function sendViaMailBin({ to, subject, plainText }) {
  return new Promise((resolve, reject) => {
    if (!MAIL_BIN) return reject(new Error('No mail/mailx binary found'));
    const recipients = normaliseRecipients(to);
    if (!recipients.length) return reject(new Error('No recipients'));
    const args  = ['-s', sanitiseSubject(subject), ...recipients];
    const child = spawn(MAIL_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MAILRC: '/dev/null', NAME: FROM_NAME(), EMAIL: FROM_EMAIL() },
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`mail exited ${code}${stderr ? ': ' + stderr.trim() : ''}`));
    });
    child.stdin.write(String(plainText || ''));
    child.stdin.end();
  });
}

/**
 * Main send entry point.
 * Tries sendmail (HTML+text) first, falls back to mailx (text only).
 * @param {{ to, subject, plainText, html }} opts
 */
async function send({ to, subject, plainText, html }) {
  const recipients = normaliseRecipients(to);
  if (!recipients.length) throw new Error('No recipients supplied');

  // Build the HTML part (always present; callers may pass it or we skip)
  const htmlPart = html || null;

  // Try sendmail with full MIME if both sendmail and HTML are available
  if (SENDMAIL_BIN && htmlPart) {
    const mime = buildMimeMessage({
      to:        recipients,
      subject,
      plainText: plainText || '',
      html:      htmlPart,
      fromName:  FROM_NAME(),
      fromEmail: FROM_EMAIL(),
    });
    try {
      await sendViaSendmail({ mimeMessage: mime });
      return;
    } catch (err) {
      console.warn(`[NetWatch Mail] sendmail failed (${err.message}), trying mailx fallback`);
    }
  }

  // Fallback: plain-text via mailx
  await sendViaMailBin({ to: recipients, subject, plainText: plainText || '' });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  send,
  MAIL_BIN:             () => MAIL_BIN,
  MAIL_BIN_AVAILABLE:   () => !!(SENDMAIL_BIN || MAIL_BIN),
  SENDMAIL_BIN:         () => SENDMAIL_BIN,
  FROM_NAME,
  FROM_EMAIL,
  MONITOR_HOST,
  nowIST,
  toIST,
  esc,
  // Plain-text builders
  buildAlertPlainText,
  buildAllClearPlainText,
  buildTestPlainText,
  // HTML builders
  buildAlertHtml,
  buildAllClearHtml,
  buildTestHtml,
};
