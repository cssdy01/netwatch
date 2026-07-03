// src/mail/transport.js
// NetWatch mail transport — intentionally matches scripts/3_run.sh option 6.
//
// Successful script behavior:
//   echo 'body' | mail -s '[NETWATCH] Mail Test' recipient@example.com
//
// This module uses the same local mailx/mail binary path. It does NOT use SMTP
// credentials, Nodemailer, custom sendmail message generation, or background
// retries. The local container Postfix relays to the host Postfix via
// POSTFIX_RELAY, exactly as configured by backend/docker/postfix-setup.sh.

const { execSync, spawn } = require('child_process');

const MONITOR_HOST = () => process.env.MONITOR_HOST || 'netwatch';
const FROM_NAME = () => process.env.MAIL_FROM_NAME || 'NetWatch Monitor';
const FROM_EMAIL = () => process.env.MAIL_FROM_EMAIL || `alerts@${MONITOR_HOST()}.local`;

function detectMailBin() {
  const candidates = [
    '/usr/bin/mail',
    '/usr/bin/mailx',
    '/usr/bin/bsd-mailx',
    '/bin/mail',
    'mail',
    'mailx',
    'bsd-mailx',
  ];

  for (const candidate of candidates) {
    try {
      if (candidate.startsWith('/')) {
        execSync(`test -x ${candidate}`, { stdio: 'pipe', shell: true });
        console.log(`[NetWatch Mail] Using script-compatible mail binary: ${candidate}`);
        return candidate;
      }
      const found = execSync(`command -v ${candidate} 2>/dev/null`, {
        stdio: 'pipe',
        shell: true,
      }).toString().trim();
      if (found) {
        console.log(`[NetWatch Mail] Using script-compatible mail binary: ${found}`);
        return found;
      }
    } catch (_) {
      // try next candidate
    }
  }

  console.warn('[NetWatch Mail] WARNING: no mail/mailx binary found. Rebuild backend image.');
  return null;
}

const MAIL_BIN = detectMailBin();

function normaliseRecipients(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(',');
  return [...new Set(list.map(x => String(x).trim()).filter(Boolean))];
}

function sanitiseSubject(subject) {
  return String(subject || '[NETWATCH] Notification').replace(/[\r\n]+/g, ' ').trim();
}

function sendViaMail({ to, subject, body }) {
  return new Promise((resolve, reject) => {
    if (!MAIL_BIN) {
      return reject(new Error('No mail/mailx binary found inside backend container'));
    }

    const recipients = normaliseRecipients(to);
    if (!recipients.length) return reject(new Error('No recipients supplied'));

    // Same semantics as 3_run.sh option 6:
    //   echo "$body" | mail -s "$subject" recipient1 recipient2
    const args = ['-s', sanitiseSubject(subject), ...recipients];
    const child = spawn(MAIL_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Keep mailx deterministic and prevent user-level mailrc surprises.
        MAILRC: '/dev/null',
        NAME: FROM_NAME(),
        EMAIL: FROM_EMAIL(),
      },
    });

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`mail exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });

    child.stdin.write(String(body || ''));
    if (!String(body || '').endsWith('\n')) child.stdin.write('\n');
    child.stdin.end();
  });
}

async function send({ to, subject, plainText }) {
  await sendViaMail({ to, subject, body: plainText });
}

function nowIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }) + ' IST';
}

function formatUrls(task) {
  if (task.type !== 'APPLICATION') return '';
  try {
    const urls = JSON.parse(task.urls || '[]');
    if (!urls.length) return '';
    return '\nURLs          :\n' + urls.map(u => `  - ${typeof u === 'string' ? u : u.url}`).join('\n');
  } catch (_) {
    return '';
  }
}

function buildAlertPlainText({ task, t0, tier, errorRaw, incidentDuration }) {
  const tierLabels = {
    L1: 'Level 1 - Initial fault alert',
    L2: 'Level 2 - Fault still open after 48 hours',
    L3: 'Level 3 - Repeated escalation every 48 hours until recovery',
  };

  const typeLabel = task.type === 'PING'
    ? `Ping / ICMP (${task.os_type || 'Unknown OS'})`
    : 'Application (HTTP/HTTPS)';

  const startIST = new Date(t0).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }) + ' IST';

  return `Hello Team,

NetWatch Monitor has detected a fault that requires your attention.

Job Name      : ${task.name}
Target        : ${task.target}
Type          : ${typeLabel}${formatUrls(task)}
Alert Tier    : ${tierLabels[tier] || tier}
Incident Start: ${startIST}${incidentDuration ? `\nOpen For      : ${incidentDuration}` : ''}
Monitor Host  : ${MONITOR_HOST()}
Status        : FAULT

------------------------------------------------------------
Error Details
------------------------------------------------------------
${errorRaw || 'No error details captured'}
------------------------------------------------------------

Regards,
${FROM_NAME()} (${MONITOR_HOST()})
`;
}

function buildAllClearPlainText({ task, downtimeDuration }) {
  return `Hello Team,

The following target has recovered and is back online.

Job Name      : ${task.name}
Target        : ${task.target}
Recovery Time : ${nowIST()}
Total Downtime: ${downtimeDuration}
Monitor Host  : ${MONITOR_HOST()}
Status        : RECOVERED

Failure counters and escalation timers have been reset.

Regards,
${FROM_NAME()} (${MONITOR_HOST()})
`;
}

function buildTestPlainText() {
  return `Hello,

This is a test mail from NetWatch Monitor.
Your system mail configuration is working correctly.

Monitor Host : ${MONITOR_HOST()}
Mail Method  : mailx/mail (${MAIL_BIN || 'not found'})
Relay        : ${process.env.POSTFIX_RELAY || '172.17.0.1:25'}
Sent At      : ${nowIST()}

Regards,
${FROM_NAME()} (${MONITOR_HOST()})
`;
}

module.exports = {
  send,
  MAIL_BIN: () => MAIL_BIN,
  MAIL_BIN_AVAILABLE: () => !!MAIL_BIN,
  FROM_NAME,
  FROM_EMAIL,
  MONITOR_HOST,
  nowIST,
  buildAlertPlainText,
  buildAllClearPlainText,
  buildTestPlainText,
};
