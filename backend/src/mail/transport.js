// src/mail/transport.js — Direct SMTP Client Engine
const nodemailer = require('nodemailer');

const MONITOR_HOST = () => process.env.MONITOR_HOST || 'netwatch';
const FROM_NAME    = () => process.env.MAIL_FROM_NAME  || 'NetWatch Monitor';
const FROM_EMAIL   = () => process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER;

// Configure Native Connection Pool
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465', // true for 465, false for 587/25
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    // Prevent self-signed cert issues with internal mail networks
    rejectUnauthorized: false
  }
});

// Maintain file signatures for contract safety across controllers
const MAIL_BIN = () => 'nodemailer';
const MAIL_BIN_AVAILABLE = () => true;

function normaliseRecipients(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(',');
  return [...new Set(list.map(x => String(x).trim()).filter(Boolean))];
}

function sanitiseSubject(subject) {
  return String(subject || '[NETWATCH] Notification').replace(/[\r\n]+/g, ' ').trim();
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Direct SMTP Connection Sender
 */
async function send({ to, subject, plainText, html }) {
  const recipients = normaliseRecipients(to);
  if (!recipients.length) throw new Error('No recipients supplied');

  await transporter.sendMail({
    from: `"${FROM_NAME()}" <${FROM_EMAIL()}>`,
    to: recipients.join(', '),
    subject: sanitiseSubject(subject),
    text: plainText || '',
    html: html || '',
  });
}

// ─── IST Helpers ───
function nowIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }) + ' IST';
}

function toIST(utcStr) {
  if (!utcStr) return '—';
  return new Date(utcStr).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }) + ' IST';
}

// ─── Plain-Text Builders ───
const TIER_LABEL = {
  L1: 'L1 - Initial fault',
  L2: 'L2 - Escalation (open 48h)',
  L3: 'L3 - Repeated escalation',
};

function getUrlsText(task) {
  if (task.type !== 'APPLICATION') return null;
  try {
    const urls = JSON.parse(task.urls || '[]');
    if (!urls.length) return null;
    return urls.map(u => (typeof u === 'string' ? u : u.url)).join('\n             ');
  } catch { return null; }
}

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
Mail Method  : Direct SMTP Engine
Sent At      : ${nowIST()}

Status:
Mail configuration is working correctly.

Regards,
NetWatch Monitor | ${MONITOR_HOST()}
`;
}

// ─── HTML Builders ───
const THEME = {
  red:    { header: '#c0392b', light: '#fdf2f2', border: '#e74c3c' },
  orange: { header: '#c0550a', light: '#fdf5ef', border: '#d35400' },
  green:  { header: '#1a6b3a', light: '#f0faf3', border: '#27ae60' },
  blue:   { header: '#154360', light: '#eaf2fb', border: '#1f618d' },
};

function baseHtml({ colour, headerTitle, headerSub, rows, errorText, statusText }) {
  const t   = THEME[colour] || THEME.blue;
  const mon = esc(MONITOR_HOST());

  const rowsHtml = (rows || []).map(([label, value]) => `
      <tr>
        <td style="padding:5px 14px 5px 0;width:120px;font-size:13px;color:#555555;vertical-align:top;white-space:nowrap;">${esc(label)}</td>
        <td style="padding:5px 0;font-size:13px;color:#111111;vertical-align:top;word-break:break-all;">${value}</td>
      </tr>`).join('');

  const errorHtml = errorText ? `
    <div style="margin-top:16px;">
      <p style="margin:0 0 5px 0;font-size:11px;color:#555555;font-weight:bold;text-transform:uppercase;letter-spacing:.4px;">Error Details</p>
      <div style="background:#fdf2f2;border-left:3px solid #c0392b;padding:9px 11px;font-family:Courier New,Courier,monospace;font-size:12px;color:#7b241c;white-space:pre-wrap;word-break:break-all;">${esc(errorText)}</div>
    </div>` : '';

  const statusHtml = statusText ? `
    <div style="margin-top:16px;background:${t.light};border:1px solid ${t.border};padding:9px 13px;font-size:13px;color:#333333;">${esc(statusText)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${esc(headerTitle)}</title></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f0f0;padding:20px 0;">
  <tr><td align="center">
    <table width="540" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;width:100%;background:#ffffff;border:1px solid #cccccc;">
      <tr><td style="background:${t.header};padding:14px 20px;">
        <p style="margin:0;font-size:10px;color:rgba(255,255,255,0.7);letter-spacing:.8px;text-transform:uppercase;">NetWatch Monitor</p>
        <p style="margin:3px 0 0 0;font-size:17px;color:#ffffff;font-weight:bold;">${esc(headerTitle)}</p>
        <p style="margin:3px 0 0 0;font-size:12px;color:rgba(255,255,255,0.8);">${esc(headerSub)}</p>
      </td></tr>
      <tr><td style="padding:18px 22px 22px 22px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${rowsHtml}
        </table>
        ${errorHtml}
        ${statusHtml}
      </td></tr>
      <tr><td style="padding:10px 22px;border-top:1px solid #eeeeee;background:#f9f9f9;">
        <p style="margin:0;font-size:11px;color:#888888;">Regards,&nbsp;<strong style="color:#444444;">NetWatch Monitor</strong> | ${mon}</p>
        <p style="margin:3px 0 0 0;font-size:10px;color:#bbbbbb;">Automated notification. Do not reply.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function getUrlsHtml(task) {
  if (task.type !== 'APPLICATION') return null;
  try {
    const urls = JSON.parse(task.urls || '[]');
    if (!urls.length) return null;
    return urls.map(u => `<span style="word-break:break-all;">${esc(typeof u === 'string' ? u : u.url)}</span>`).join('<br>');
  } catch { return null; }
}

function buildAlertHtml({ task, t0, tier, errorRaw }) {
  const colour    = tier === 'L1' ? 'red' : 'orange';
  const titles    = { L1: 'ALERT — DOWN', L2: 'ESCALATION — STILL DOWN', L3: 'ESCALATION — STILL DOWN' };
  const subs      = { L1: 'Initial fault detected', L2: 'Open for 48 hours', L3: 'Repeated 48h escalation' };
  const typeLabel = task.type === 'PING' ? 'Ping / ICMP' : 'Application';
  const urlsHtml  = getUrlsHtml(task);

  return baseHtml({
    colour,
    headerTitle: `NETWATCH ${titles[tier] || 'ALERT'}`,
    headerSub:   subs[tier] || '',
    rows: [
      ['Task',           esc(task.name)],
      ['Type',           esc(typeLabel)],
      ['System IP',      esc(task.target)],
      ...(urlsHtml ? [['URL', urlsHtml]] : []),
      ['Alert',          esc(TIER_LABEL[tier] || tier)],
      ['Incident Start', esc(toIST(t0))],
    ],
    errorText: errorRaw || 'No error details captured',
  });
}

function buildAllClearHtml({ task, downtimeDuration }) {
  const typeLabel = task.type === 'PING' ? 'Ping / ICMP' : 'Application';
  return baseHtml({
    colour:      'green',
    headerTitle: 'NETWATCH ALL CLEAR',
    headerSub:   'Service has recovered',
    rows: [
      ['Task',      esc(task.name)],
      ['Type',      esc(typeLabel)],
      ['System IP', esc(task.target)],
      ['Recovered', esc(nowIST())],
      ['Downtime',  esc(downtimeDuration)],
    ],
    statusText: 'Service is back online.',
  });
}

// Fixed function parameters to support contextless testing triggers safely
function buildTestHtml() {
  return baseHtml({
    colour:      'blue',
    headerTitle: 'NETWATCH MAIL TEST',
    headerSub:   'Mail configuration check',
    rows: [
      ['Monitor Host', esc(process.env.MONITOR_HOST || 'localhost')],
      ['Mail Method',  'Direct SMTP via Nodemailer Pool'],
      ['Relay Server', esc(process.env.SMTP_HOST || 'not-set')],
      ['Sent At',      esc(nowIST())],
    ],
    statusText: 'Mail configuration is working correctly.',
  });
}

module.exports = {
  send,
  MAIL_BIN:             () => MAIL_BIN,
  MAIL_BIN_AVAILABLE:   () => !!MAIL_BIN,
  FROM_NAME,
  FROM_EMAIL,
  MONITOR_HOST,
  nowIST,
  toIST,
  esc,
  buildAlertPlainText,
  buildAllClearPlainText,
  buildTestPlainText,
  buildAlertHtml,
  buildAllClearHtml,
  buildTestHtml,
};