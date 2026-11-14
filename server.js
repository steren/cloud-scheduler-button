const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Get job name from environment variable
const jobName = process.env.JOB_NAME;
if (!jobName) {
  throw new Error('Environment variable JOB_NAME not set.');
}

const template = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Get a value from the metadata server
function getMetadata(metadataPath) {
  const options = {
    hostname: 'metadata.google.internal',
    path: `/computeMetadata/v1/${metadataPath}`,
    headers: { 'Metadata-Flavor': 'Google' },
  };

  return new Promise((resolve, reject) => {
    const req = http.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Error getting metadata: ${res.statusCode} - ${res.statusMessage}`));
        }
      });
    });
    req.on('error', (error) => {
      reject(new Error('Error requesting metadata: ' + error.message));
    });
  });
}

// Project and location never change for a running instance: resolve them once
let jobPathPromise;
function getJobPath() {
  if (!jobPathPromise) {
    jobPathPromise = (async () => {
      const projectId = await getMetadata('project/project-id');
      let location = process.env.REGION;
      if (!location) {
        // Returns in the format 'projects/PROJECT_NUMBER/regions/REGION'
        const region = await getMetadata('instance/region');
        location = region.split('/').pop();
      }
      return `/v1/projects/${projectId}/locations/${location}/jobs/${jobName}`;
    })();
    jobPathPromise.catch(() => { jobPathPromise = null; });
  }
  return jobPathPromise;
}

async function getToken() {
  const data = await getMetadata('instance/service-accounts/default/token');
  return JSON.parse(data).access_token;
}

// Call the Cloud Scheduler API on the job. `action` is '', ':pause' or ':resume'.
// Resolves with the Job resource.
async function callScheduler(method, action = '') {
  const [jobPath, token] = await Promise.all([getJobPath(), getToken()]);
  const body = method === 'POST' ? '{}' : null;
  const options = {
    hostname: 'cloudscheduler.googleapis.com',
    path: jobPath + action,
    method,
    headers: { 'Authorization': `Bearer ${token}` },
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { /* not JSON */ }
        if (res.statusCode === 200 && parsed) {
          resolve(parsed);
        } else {
          const detail = (parsed && parsed.error && parsed.error.message) || data || res.statusMessage;
          reject(new Error(`Cloud Scheduler API returned ${res.statusCode}: ${detail}`));
        }
      });
    });
    req.on('error', (error) => {
      reject(new Error('Error calling Cloud Scheduler API: ' + error.message));
    });
    req.end(body || undefined);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// "in 5 minutes" / "2 hours ago"
function relativeTime(date, now = new Date()) {
  const seconds = Math.round((date - now) / 1000);
  const abs = Math.abs(seconds);
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (abs >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return seconds >= 0 ? 'in less than a minute' : 'less than a minute ago';
}

// Absolute time in the job's own time zone, with a relative hint
function formatTime(timestamp, timeZone) {
  const date = new Date(timestamp);
  if (isNaN(date)) return escapeHtml(timestamp);
  const options = { dateStyle: 'medium', timeStyle: 'short' };
  let absolute;
  try {
    absolute = new Intl.DateTimeFormat('en', { ...options, timeZone }).format(date);
  } catch (e) {
    absolute = new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' }).format(date) + ' UTC';
  }
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(absolute)}</time>` +
    ` <span class="hint">${escapeHtml(relativeTime(date))}</span>`;
}

const STATES = {
  ENABLED: { label: 'Enabled', className: 'enabled', summary: 'The job runs on its schedule.' },
  PAUSED: { label: 'Paused', className: 'paused', summary: 'The job will not run until it is resumed.' },
  DISABLED: { label: 'Disabled', className: 'failed', summary: 'The job was disabled by the system after an error.' },
  UPDATE_FAILED: { label: 'Update failed', className: 'failed', summary: 'The last update of the job failed.' },
};

const pauseButton = '<form action="/stop-job" method="POST"><button type="submit" class="pause">Pause job</button></form>';
const resumeButton = '<form action="/start-job" method="POST"><button type="submit" class="resume">Resume job</button></form>';

function renderPage({ job, error }) {
  let badge = '<span class="badge unknown">Unknown</span>';
  let summary = 'The status of the job could not be retrieved.';
  let details = '';
  // Without a known state, offer both actions
  let actions = pauseButton + resumeButton;

  if (job) {
    const state = STATES[job.state] ||
      { label: job.state || 'Unknown', className: 'unknown', summary: '' };
    badge = `<span class="badge ${state.className}">${escapeHtml(state.label)}</span>`;
    summary = state.summary;

    const rows = [];
    if (job.description) rows.push(['Description', escapeHtml(job.description)]);
    if (job.schedule) {
      rows.push(['Schedule', `<code>${escapeHtml(job.schedule)}</code>` +
        (job.timeZone ? ` <span class="hint">${escapeHtml(job.timeZone)}</span>` : '')]);
    }
    if (job.state === 'ENABLED' && job.scheduleTime) {
      rows.push(['Next run', formatTime(job.scheduleTime, job.timeZone)]);
    }
    if (job.lastAttemptTime) {
      rows.push(['Last run', formatTime(job.lastAttemptTime, job.timeZone)]);
      const failed = job.status && job.status.code;
      rows.push(['Last result', failed
        ? `<span class="result bad">Failed</span> <span class="hint">${escapeHtml(job.status.message || 'code ' + job.status.code)}</span>`
        : '<span class="result good">Succeeded</span>']);
    } else {
      rows.push(['Last run', '<span class="hint">Never</span>']);
    }
    details = '<dl>' + rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('') + '</dl>';

    if (job.state === 'ENABLED') actions = pauseButton;
    else if (job.state === 'PAUSED') actions = resumeButton;
    else actions = '';
  }

  const values = {
    jobName: escapeHtml(jobName),
    badge,
    summary: escapeHtml(summary),
    error: error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '',
    details,
    actions,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? values[key] : match));
}

function sendPage(res, statusCode, model) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(renderPage(model));
}

// Main request handler
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/' && req.method === 'GET') {
    try {
      sendPage(res, 200, { job: await callScheduler('GET') });
    } catch (error) {
      console.error('Error getting job:', error);
      sendPage(res, 502, { error: error.message });
    }
  } else if ((pathname === '/stop-job' || pathname === '/start-job') && req.method === 'POST') {
    const action = pathname === '/stop-job' ? 'pause' : 'resume';
    console.log(`Received request to ${action} job.`);
    try {
      await callScheduler('POST', ':' + action);
      // Redirect so that the page shows the new status and can be safely reloaded
      res.statusCode = 303;
      res.setHeader('Location', '/');
      res.end();
    } catch (error) {
      console.error(`Error trying to ${action} job:`, error);
      const job = await callScheduler('GET').catch(() => null);
      sendPage(res, 502, { job, error: `Failed to ${action} job. ${error.message}` });
    }
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

const port = process.env.PORT || 8080;

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
