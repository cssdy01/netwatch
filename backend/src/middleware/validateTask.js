// src/middleware/validateTask.js
// Task input validation.
// Exported both as default and named export because different builds of
// tasksController may import it as either:
//   const validateTask = require('../middleware/validateTask')
// or:
//   const { validateTask } = require('../middleware/validateTask')

// FIX: minimum interval raised from 5 to match db.js and monitoringService MIN_INTERVAL_MIN.
// The original code said "Minimum interval is 5 minutes" in the error but the schema
// allowed 3. Now all three places (db.js, validateTask.js, monitoringService) agree on 5.
const MIN_INTERVAL_MIN = 5;

function validateTask(req, res, next) {
  const { name, type, target, interval_min, urls } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Task name is required' });
  }

  if (!type || !['PING', 'APPLICATION'].includes(type)) {
    return res.status(400).json({ error: 'Type must be PING or APPLICATION' });
  }

  if (!target || !target.trim()) {
    return res.status(400).json({ error: 'Target is required' });
  }

  const intervalNum = parseInt(interval_min, 10);
  if (Number.isNaN(intervalNum) || intervalNum < MIN_INTERVAL_MIN) {
    return res.status(400).json({ error: `Minimum interval is ${MIN_INTERVAL_MIN} minutes` });
  }

  if (type === 'APPLICATION') {
    let parsedUrls = urls;
    if (typeof urls === 'string') {
      try {
        parsedUrls = JSON.parse(urls);
      } catch (_) {
        return res.status(400).json({ error: 'URLs must be valid JSON' });
      }
    }

    if (!Array.isArray(parsedUrls) || parsedUrls.length === 0) {
      return res.status(400).json({ error: 'At least one URL is required for APPLICATION tasks' });
    }
  }

  for (const field of ['email_l1', 'email_l2', 'email_l3']) {
    const val = req.body[field];
    if (!val) continue;

    const emails = val.split(',').map(e => e.trim()).filter(Boolean);
    if (emails.length > 3) {
      return res.status(400).json({ error: `${field}: maximum 3 email addresses per level` });
    }

    for (const e of emails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return res.status(400).json({ error: `${field}: "${e}" is not a valid email address` });
      }
    }
  }

  next();
}

module.exports = validateTask;
module.exports.validateTask = validateTask;
