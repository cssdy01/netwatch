// src/mail/mailService.js
// Single entry point for all outbound mail in NetWatch.
// Uses transport.js, which intentionally mirrors scripts/3_run.sh option 6.
// No scheduler sends test email; test email is sent only by /api/logs/test-email.

const {
  send,
  MAIL_BIN_AVAILABLE,
  buildAlertPlainText,
  buildAllClearPlainText,
  buildTestPlainText,
} = require('./transport');
const { log } = require('../services/appLog');

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

function formatDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

const SUBJECTS = {
  L1:    n => `[NETWATCH ALERT] ${n} - DOWN (Level 1)`,
  L2:    n => `[NETWATCH ESCALATION] ${n} - Still DOWN 48h+ (Level 2)`,
  L3:    n => `[NETWATCH CRITICAL] ${n} - Still DOWN, repeated 48h escalation (Level 3)`,
  CLEAR: n => `[NETWATCH ALL CLEAR] ${n} - Recovered`,
  TEST:  () => '[NETWATCH] Mail Test',
};

async function sendAlert({ task, incidentState, tier, errorRaw }) {
  const recipients = collectRecipients(task, tier);
  if (recipients.length === 0) {
    log('WARN', 'EMAIL', 'scheduler', task.id, `${tier} skipped - no valid recipients`, null);
    return false;
  }

  const t0 = new Date(incidentState.t0);
  const diffMs = Date.now() - t0.getTime();
  const plainText = buildAlertPlainText({
    task,
    t0: incidentState.t0,
    tier,
    errorRaw,
    incidentDuration: diffMs > 60000 ? formatDuration(diffMs) : null,
  });

  await send({ to: recipients, subject: SUBJECTS[tier](task.name), plainText });
  log('INFO', 'EMAIL', 'scheduler', task.id,
    `${tier} mail sent for "${task.name}" -> ${recipients.join(', ')}`, null);
  return true;
}

async function sendAllClear({ task, t0 }) {
  const recipients = collectAllRecipients(task);
  if (recipients.length === 0) return false;

  const downtimeDuration = formatDuration(Date.now() - new Date(t0).getTime());
  await send({
    to: recipients,
    subject: SUBJECTS.CLEAR(task.name),
    plainText: buildAllClearPlainText({ task, downtimeDuration }),
  });
  log('INFO', 'EMAIL', 'scheduler', task.id,
    `All Clear mail sent for "${task.name}" - downtime: ${downtimeDuration}`, null);
  return true;
}

async function sendTestEmail(to) {
  // Explicit-only path. Do not call from any scheduler, monitor cycle, retry loop, or startup hook.
  await send({
    to,
    subject: SUBJECTS.TEST(),
    plainText: buildTestPlainText(),
  });
}

module.exports = {
  sendAlert,
  sendAllClear,
  sendTestEmail,
  parseEmails,
  collectRecipients,
  collectAllRecipients,
  MAIL_BIN_AVAILABLE,
};
