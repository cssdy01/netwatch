// src/mail/mailService.js
// Phase 5: HTML email with plain-text fallback.
// Escalation logic, recipient collection, and logging unchanged.
// Subject format updated per spec.

const {
  send,
  MAIL_BIN_AVAILABLE,
  buildAlertPlainText,
  buildAllClearPlainText,
  buildTestPlainText,
  buildAlertHtml,
  buildAllClearHtml,
  buildTestHtml,
  MONITOR_HOST,
} = require('./transport');
const { log } = require('../services/appLog');

// ── Recipients ────────────────────────────────────────────────────────────────

function parseEmails(str) {
  if (!str) return [];
  return str.split(',')
    .map(e => e.trim())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    .slice(0, 3);
}

function collectRecipients(task, tier) {
  const l1 = parseEmails(task.email_l1);
  const l2 = parseEmails(task.email_l2);
  const l3 = parseEmails(task.email_l3);
  const map = { L1: [...l1], L2: [...l1, ...l2], L3: [...l1, ...l2, ...l3] };
  return [...new Set(map[tier] || l1)];
}

function collectAllRecipients(task) {
  return [...new Set([
    ...parseEmails(task.email_l1),
    ...parseEmails(task.email_l2),
    ...parseEmails(task.email_l3),
  ])];
}

// ── Duration ──────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!h) parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Subjects (updated format per spec) ───────────────────────────────────────

/**
 * Returns "Application" for APPLICATION tasks, "System" for PING tasks.
 */
function typeWord(task) {
  return task.type === 'APPLICATION' ? 'Application' : 'System';
}

function buildSubject(task, tier) {
  const n = task.name;
  const t = typeWord(task);
  switch (tier) {
    case 'L1':    return `[NETWATCH L1] ${n} ${t} is DOWN`;
    case 'L2':    return `[NETWATCH L2] ${n} ${t} still DOWN for 48h`;
    case 'L3':    return `[NETWATCH L3] ${n} ${t} still DOWN - repeated escalation`;
    case 'CLEAR': return `[NETWATCH CLEAR] ${n} ${t} recovered`;
    case 'TEST':  return '[NETWATCH TEST] Mail configuration OK';
    default:      return `[NETWATCH] ${n} - ${tier}`;
  }
}

// ── Send helpers ──────────────────────────────────────────────────────────────

async function sendAlert({ task, incidentState, tier, errorRaw }) {
  const recipients = collectRecipients(task, tier);
  if (!recipients.length) {
    log('WARN', 'EMAIL', 'scheduler', task.id,
      `${tier} skipped — no valid recipients for "${task.name}"`, null);
    return false;
  }

  const t0 = incidentState?.t0;

  const plainText = buildAlertPlainText({ task, t0, tier, errorRaw });
  const html      = buildAlertHtml({ task, t0, tier, errorRaw });
  const subject   = buildSubject(task, tier);

  try {
    await send({ to: recipients, subject, plainText, html });
    log('INFO', 'EMAIL', 'scheduler', task.id,
      `${tier} mail sent for "${task.name}" → ${recipients.join(', ')}`, null);
    return true;
  } catch (err) {
    log('ERROR', 'EMAIL', 'scheduler', task.id,
      `${tier} mail FAILED for "${task.name}": ${err.message}`, err.stack);
    throw err;
  }
}

async function sendAllClear({ task, t0 }) {
  const recipients = collectAllRecipients(task);
  if (!recipients.length) return false;

  const downtimeDuration = formatDuration(Date.now() - new Date(t0).getTime());
  const plainText = buildAllClearPlainText({ task, downtimeDuration });
  const html      = buildAllClearHtml({ task, downtimeDuration });
  const subject   = buildSubject(task, 'CLEAR');

  try {
    await send({ to: recipients, subject, plainText, html });
    log('INFO', 'EMAIL', 'scheduler', task.id,
      `All Clear mail sent for "${task.name}" — downtime: ${downtimeDuration}`, null);
    return true;
  } catch (err) {
    log('ERROR', 'EMAIL', 'scheduler', task.id,
      `All Clear mail FAILED for "${task.name}": ${err.message}`, err.stack);
    throw err;
  }
}

async function sendTestEmail(to) {
  // Explicit-only. Never called from scheduler or monitor cycle.
  const subject   = buildSubject({}, 'TEST');
  const plainText = buildTestPlainText();
  const html      = buildTestHtml();
  await send({ to, subject, plainText, html });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  sendAlert,
  sendAllClear,
  sendTestEmail,
  parseEmails,
  collectRecipients,
  collectAllRecipients,
  MAIL_BIN_AVAILABLE,
};
