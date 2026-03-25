/**
 * ============================================================
 *  POGI SCRIPTS
 *  Do not edit this code without informing James Pogio
 *  Contact: james.pogio@eagleview.com
 * ============================================================
 */

// ===== API Endpoints =====
const BASE_URL       = 'https://api.cmh.platform-prod2.evinternal.net/operations-center/api/Task/';
const STATE_BASE_URL = 'https://api.cmh.platform-prod2.evinternal.net/operations-center/api/TaskState/';
const JOB_BASE_URL   = 'https://api.cmh.platform-prod.evinternal.net/inform-measures/hipster/v3/job';
const NOTES_BASE_URL = 'https://api.cmh.platform-prod.evinternal.net/inform-measures/hipster/v3/note';

let lastData = null;
let lastJobData = null;
let lastNotesData = null;

// Combined timeline storage
let storedStates = null;
let storedEmailMap = {};
let storedNotes = null;
let allStates = [];
let allNotes = [];

// ===== DOM References =====
const reportIdInput  = document.getElementById('reportId');
const urlPreview     = document.getElementById('urlPreview');
const statusBox      = document.getElementById('statusBox');
const statusText     = document.getElementById('statusText');
const resultPanel    = document.getElementById('resultPanel');
const fieldsGrid     = document.getElementById('fieldsGrid');
const rawJson        = document.getElementById('rawJson');
const resultMeta     = document.getElementById('resultMeta');
const fetchBtn       = document.getElementById('fetchBtn');

const stateSection   = document.getElementById('stateSection');
const stateStatusBox = document.getElementById('stateStatusBox');
const stateStatusText= document.getElementById('stateStatusText');
const statePanel     = document.getElementById('statePanel');
const stateTableBody = document.getElementById('stateTableBody');
const stateCount     = document.getElementById('stateCount');

const jobInfoSection = document.getElementById('jobInfoSection');
const jobStatusBox   = document.getElementById('jobStatusBox');
const jobStatusText  = document.getElementById('jobStatusText');
const jobPanel       = document.getElementById('jobPanel');
const jobTableBody   = document.getElementById('jobTableBody');
const jobCount       = document.getElementById('jobCount');

// ===== Event Listeners =====
reportIdInput.addEventListener('input', () => {
  const val = reportIdInput.value.trim();
  if (val) {
    urlPreview.innerHTML = `${BASE_URL}<span class="url-highlight">${encodeURIComponent(val)}</span>`;
  } else {
    urlPreview.textContent = 'Enter a Report ID to see the API endpoint';
  }
});

reportIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchTask();
});

// ===== Status Helpers =====
function showStatus(type, message) {
  statusBox.className = 'status ' + type;
  statusText.textContent = message;
  document.getElementById('spinner').style.display = type === 'loading' ? 'block' : 'none';
}

function hideStatus() { statusBox.className = 'status'; }

function showStateStatus(type, message) {
  stateStatusBox.className = 'state-status ' + type;
  stateStatusText.textContent = message;
  document.getElementById('stateSpinner').style.display = type === 'loading' ? 'block' : 'none';
}

function hideStateStatus() { stateStatusBox.className = 'state-status'; }

// ===== Fetch with Retry + Concurrency Pool =====
const MAX_CONCURRENT = 5;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' }, ...options });
      if (resp.ok) return resp;
      if (resp.status >= 500 && attempt < retries) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`Retry ${attempt + 1}/${retries} for ${url} (HTTP ${resp.status}), waiting ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      if (attempt < retries && (err.name === 'TypeError' || err.message.includes('fetch'))) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`Retry ${attempt + 1}/${retries} for ${url} (${err.message}), waiting ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

function concurrencyPool(tasks, limit) {
  return new Promise((resolve) => {
    const results = [];
    let running = 0;
    let index = 0;

    function next() {
      if (index >= tasks.length && running === 0) { resolve(results); return; }
      while (running < limit && index < tasks.length) {
        const i = index++;
        running++;
        tasks[i]().then(val => { results[i] = { status: 'fulfilled', value: val }; })
                  .catch(err => { results[i] = { status: 'rejected', reason: err }; })
                  .finally(() => { running--; next(); });
      }
    }
    next();
  });
}

// ===== Main Fetch Function =====
async function fetchTask() {
  const rawInput = reportIdInput.value.trim();
  if (!rawInput) { reportIdInput.focus(); return; }

  const reportIds = [...new Set(rawInput.split(/[,\n]+/).map(s => s.trim()).filter(Boolean))];
  if (reportIds.length === 0) { reportIdInput.focus(); return; }

  fetchBtn.disabled = true;
  resultPanel.classList.remove('visible');
  stateSection.style.display = 'none';
  statePanel.classList.remove('visible');
  jobInfoSection.style.display = 'none';
  jobPanel.classList.remove('visible');
  storedStates = null;
  storedEmailMap = {};
  storedNotes = null;
  allStates = [];
  allNotes = [];
  hideStatus();

  const totalIds = reportIds.length;
  let completedCount = 0;
  let failedCount = 0;
  showStatus('loading', `Fetching data for ${totalIds} report ID${totalIds > 1 ? 's' : ''}…`);

  // Show skeleton loader
  const skeletonLoader = document.getElementById('skeletonLoader');
  const tableWrap = document.getElementById('tableWrap');
  stateSection.style.display = 'block';
  statePanel.classList.add('visible');
  if (skeletonLoader) skeletonLoader.classList.add('active');
  if (tableWrap) tableWrap.style.display = 'none';

  function processReportId(reportId) {
    return async () => {
      try {
        const response = await fetchWithRetry(`${BASE_URL}${encodeURIComponent(reportId)}`);
        const data = await response.json();
        const taskId = data.id || data.taskId || data.taskID || data.Id;

        if (taskId) {
          try {
            const stateResp = await fetchWithRetry(`${STATE_BASE_URL}${encodeURIComponent(taskId)}`);
            const states = await stateResp.json();
            const stateArr = Array.isArray(states) ? states : [states];
            allStates.push(...stateArr);
          } catch (e) { console.error(`State error for ${reportId}:`, e.message); }
        }

        try {
          const jobResp = await fetchWithRetry(`${JOB_BASE_URL}?requester_id=${encodeURIComponent(reportId)}&source=gov`);
          const jobData = await jobResp.json();
          const jobArray = Array.isArray(jobData) ? jobData : [jobData];
          if (jobArray.length > 0 && jobArray[0].ID) {
            try {
              const notesResp = await fetchWithRetry(`${NOTES_BASE_URL}?job_id=${encodeURIComponent(jobArray[0].ID)}`);
              const notesData = await notesResp.json();
              const notesArray = notesData.Notes || (Array.isArray(notesData) ? notesData : [notesData]);
              notesArray.forEach(n => n._reportId = reportId);
              allNotes.push(...notesArray);
            } catch (e) { console.error(`Notes error for ${reportId}:`, e.message); }
          }
        } catch (e) { console.error(`Job error for ${reportId}:`, e.message); }

      } catch (err) {
        failedCount++;
        console.error(`Failed ${reportId} after retries: ${err.message}`);
      } finally {
        completedCount++;
        const failText = failedCount > 0 ? ` (${failedCount} failed)` : '';
        showStatus('loading', `Fetched ${completedCount}/${totalIds} report IDs${failText}…`);
      }
    };
  }

  await concurrencyPool(reportIds.map(id => processReportId(id)), MAX_CONCURRENT);

  hideStatus();
  if (failedCount > 0) {
    showStatus('error', `Completed with ${failedCount} failed report ID${failedCount > 1 ? 's' : ''} (after ${MAX_RETRIES} retries each)`);
  }

  // Hide skeleton, show table
  if (skeletonLoader) skeletonLoader.classList.remove('active');
  if (tableWrap) tableWrap.style.display = '';

  stateSection.style.display = 'block';
  storedNotes = allNotes;
  renderStateTable(allStates);

  fetchBtn.disabled = false;
}

// ===== Task State Fetch =====
async function fetchTaskState(taskId) {
  stateSection.style.display = 'block';
  statePanel.classList.remove('visible');
  showStateStatus('loading', `Fetching state history for Task ID: ${taskId}…`);

  try {
    const response = await fetch(`${STATE_BASE_URL}${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} — ${response.statusText}`);

    const states = await response.json();
    hideStateStatus();
    renderStateTable(Array.isArray(states) ? states : [states]);
    statePanel.classList.add('visible');

  } catch (err) {
    showStateStatus('error', `State fetch error: ${err.message}`);
  }
}

// ===== Job Info Fetch =====
async function fetchJobInfo(reportId) {
  jobPanel.classList.remove('visible');

  try {
    const url = `${JOB_BASE_URL}?requester_id=${encodeURIComponent(reportId)}&source=gov`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} — ${response.statusText}`);

    const jobData = await response.json();
    lastJobData = jobData;
    hideJobStatus();

    const jobArray = Array.isArray(jobData) ? jobData : [jobData];
    if (jobArray.length > 0) {
      renderJobTable(jobArray[0]);
      jobPanel.classList.add('visible');

      const jobId = jobArray[0].ID;
      if (jobId) {
        fetchNotes(jobId);
      }
    }

  } catch (err) {
    showJobStatus('error', `Job fetch error: ${err.message}`);
  }
}

// ===== Notes Fetch =====
async function fetchNotes(jobId) {
  try {
    const url = `${NOTES_BASE_URL}?job_id=${encodeURIComponent(jobId)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} — ${response.statusText}`);

    const notesData = await response.json();
    lastNotesData = notesData;

    const notesArray = notesData.Notes || (Array.isArray(notesData) ? notesData : [notesData]);
    storedNotes = notesArray;
    renderCombinedTable();

  } catch (err) {
    console.error(`Notes fetch error: ${err.message}`);
  }
}

function showJobStatus(type, message) {
  jobStatusBox.className = 'state-status ' + type;
  jobStatusText.textContent = message;
  document.getElementById('jobSpinner').style.display = type === 'loading' ? 'block' : 'none';
}

function hideJobStatus() { jobStatusBox.className = 'state-status'; }

// ===== Render State Table =====
function renderStateTable(states) {
  const filtered = states.filter(s => {
    const desc = s.description || '';
    return desc.includes('Measured-CheckIn') || desc.includes('QCed-CheckIn');
  });

  const userIds = [...new Set(filtered.map(s => s.userID ?? s.userId ?? s.userid).filter(id => id))];

  Promise.all(userIds.map(userId =>
    fetch(`https://api.cmh.platform-prod2.evinternal.net/operations-center/api/User/id?ids=${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    })
    .then(r => r.ok ? r.json() : [])
    .catch(() => [])
    .then(users => ({
      userId,
      userEmail: (Array.isArray(users) && users[0]?.userEmail) ? users[0].userEmail : '—'
    }))
  )).then(userMap => {
    const emailMap = {};
    userMap.forEach(({ userId, userEmail }) => {
      emailMap[userId] = userEmail;
    });

    storedStates = filtered;
    storedEmailMap = emailMap;
    renderCombinedTable();
  });
}

// ===== Date Formatting Helpers =====
function formatNaiveDate(dateString) {
  try {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const month = months[date.getMonth()];
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${month} ${day}, ${year}, ${hours}:${minutes}:${seconds}`;
  } catch (e) {
    return dateString;
  }
}

function formatToPacific(dateString, isSGT) {
  try {
    if (!dateString) return '—';
    let isoString = dateString.trim();
    if (isSGT && !/[Z]|[+-]\d{2}:?\d{2}\s*$/.test(isoString)) {
      isoString += '+08:00';
    }
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return dateString;
    const options = {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'America/Los_Angeles',
      hour12: false
    };
    return new Intl.DateTimeFormat('en-US', options).format(date);
  } catch (e) {
    return dateString;
  }
}

function parseDateAbsolute(dateString, assumedTZ) {
  if (!dateString) return null;
  const s = dateString.trim();
  if (/[Z]|[+-]\d{2}:?\d{2}\s*$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const naiveUtc = new Date(s + 'Z');
  if (isNaN(naiveUtc.getTime())) return null;
  const inTZ  = naiveUtc.toLocaleString('sv-SE', { timeZone: assumedTZ });
  const inUTC = naiveUtc.toLocaleString('sv-SE', { timeZone: 'UTC' });
  const offsetMs = new Date(inUTC + 'Z') - new Date(inTZ + 'Z');
  const result = new Date(naiveUtc.getTime() + offsetMs);
  return isNaN(result.getTime()) ? null : result;
}

// ===== Combined Timeline Render =====
function renderCombinedTable() {
  const entries = [];

  // Add state entries (stateTime is PDT/PST)
  if (storedStates) {
    storedStates.forEach(s => {
      const rawTime = s.stateTime || '';
      entries.push({
        rawDate: parseDateAbsolute(rawTime, 'America/Los_Angeles'),
        formattedTime: rawTime ? formatNaiveDate(rawTime) : '—',
        originalTime: rawTime || '—',
        originalTZ: 'PDT/PST',
        type: 'State',
        description: s.description || '—',
        user: storedEmailMap[s.userID ?? s.userId ?? s.userid] || s.userID || s.userId || s.userid || '—',
        userEmail: storedEmailMap[s.userID ?? s.userId ?? s.userid] || '—'
      });
    });
  }

  // Add note entries (CreatedAt is SGT → convert to PDT/PST)
  if (storedNotes) {
    storedNotes.forEach(note => {
      const createdRaw = note.CreatedAt || note.Created || note.created || '';
      entries.push({
        rawDate: parseDateAbsolute(createdRaw, 'Asia/Singapore'),
        formattedTime: createdRaw ? formatToPacific(createdRaw, true) : '—',
        originalTime: createdRaw || '—',
        originalTZ: 'SGT',
        type: 'Note',
        reportId: note._reportId || '—',
        description: note.Value || note.Content || note.content || note.text || note.Note || '—',
        user: note.Operator || '—',
        userEmail: '—'
      });
    });
  }

  // Sort by time descending (newest first)
  entries.sort((a, b) => {
    if (!a.rawDate && !b.rawDate) return 0;
    if (!a.rawDate) return 1;
    if (!b.rawDate) return -1;
    return b.rawDate - a.rawDate;
  });

  const stateLen = storedStates ? storedStates.length : 0;

  // Build lookup of previous Measured-CheckIn user
  const measuredEntries = entries
    .filter(e => e.type === 'State' && e.description && e.description.includes('Measured-CheckIn'))
    .sort((a, b) => {
      if (!a.rawDate && !b.rawDate) return 0;
      if (!a.rawDate) return 1;
      if (!b.rawDate) return -1;
      return b.rawDate - a.rawDate;
    });

  // Render rows (only Notes)
  stateTableBody.innerHTML = '';
  let rowNum = 0;
  entries.forEach((entry) => {
    if (entry.type !== 'Note') return;
    if (entry.description && /JOB REJECTED\s*[-\u2013\u2014]+\s*Reason:/i.test(entry.description)) return;
    rowNum++;
    const tr = document.createElement('tr');

    let prevUser = '—';
    for (const m of measuredEntries) {
      if (m.rawDate && entry.rawDate && m.rawDate < entry.rawDate) {
        prevUser = m.user;
        break;
      }
    }

    const desc = entry.description;
    const dashIdx = desc.indexOf('-');
    let descTag = '', descRest = desc;
    if (dashIdx > 0 && entry.type === 'State') {
      descTag = desc.substring(0, dashIdx);
      descRest = desc.substring(dashIdx + 1);
    }

    const typeBadgeClass = entry.type === 'Note' ? 'note' : 'state';

    tr.innerHTML = `
      <td class="td-user">${entry.reportId || '—'}</td>
      <td class="td-time">${entry.formattedTime}</td>
      <td class="td-user">${entry.user}</td>
      <td class="td-desc">
        ${entry.type === 'State' && descTag ? `<span class="desc-tag">${descTag}</span><br>` : ''}
        <span style="font-size:13px;">${entry.type === 'State' ? (descRest || desc) : desc}</span>
      </td>
      <td class="td-user">${prevUser}</td>
    `;

    stateTableBody.appendChild(tr);
  });

  stateCount.textContent = `${rowNum} note${rowNum !== 1 ? 's' : ''}`;
  statePanel.classList.add('visible');
}

// ===== CSV Export =====
function exportCSV() {
  const rows = [];
  rows.push(['Report ID', 'Time (PDT/PST)', 'QC', 'Description', 'Tech'].join(','));
  const trs = stateTableBody.querySelectorAll('tr');
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length >= 5) {
      const rid = tds[0].textContent.trim();
      const time = tds[1].textContent.trim();
      const qc = tds[2].textContent.trim();
      const desc = tds[3].textContent.trim().replace(/[\r\n]+/g, ' ');
      const tech = tds[4].textContent.trim();
      rows.push([csvEscape(rid), csvEscape(time), csvEscape(qc), csvEscape(desc), csvEscape(tech)].join(','));
    }
  });
  const csv = rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hipster_operator_notes.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(val) {
  if (/[,"\n\r]/.test(val)) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

// ===== Job Table Render =====
function renderJobTable(jobData) {
  jobTableBody.innerHTML = '';
  jobCount.textContent = '1 record';

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td style="font-family:var(--mono);font-size:12px;color:var(--accent2);padding:13px 12px 13px 20px;">ID</td>
    <td style="padding:13px 12px;">${jobData.ID || '—'}</td>
  `;
  jobTableBody.appendChild(tr);

  const fields = [
    { key: 'OrderId', label: 'Order ID' },
    { key: 'WorkId', label: 'Work ID' },
    { key: 'Address', label: 'Address' },
    { key: 'Longitude', label: 'Longitude' },
    { key: 'Latitude', label: 'Latitude' },
    { key: 'Status', label: 'Status' }
  ];

  fields.forEach(({ key, label }) => {
    const tr = document.createElement('tr');
    const value = jobData[key] || '—';
    tr.innerHTML = `
      <td style="font-family:var(--mono);font-size:12px;color:var(--accent2);padding:13px 12px 13px 20px;">${label}</td>
      <td style="padding:13px 12px;">${value}</td>
    `;
    jobTableBody.appendChild(tr);
  });
}

// ===== Formatted Fields Render =====
function renderFormatted(data) {
  fieldsGrid.innerHTML = '';
  flattenObject(data, '').forEach(({ key, value }) => {
    const field = document.createElement('div');
    field.className = 'field';

    const keyEl = document.createElement('div');
    keyEl.className = 'field-key';
    keyEl.textContent = key;

    const valEl = document.createElement('div');
    valEl.className = 'field-value';

    if (value === null || value === undefined) {
      valEl.textContent = 'null'; valEl.classList.add('null');
    } else if (typeof value === 'boolean') {
      valEl.textContent = String(value); valEl.classList.add(value ? 'bool-true' : 'bool-false');
    } else if (typeof value === 'number') {
      valEl.textContent = value; valEl.classList.add('number');
    } else if (typeof value === 'object') {
      valEl.textContent = JSON.stringify(value); valEl.classList.add('object');
    } else {
      valEl.textContent = String(value);
    }

    field.appendChild(keyEl);
    field.appendChild(valEl);
    fieldsGrid.appendChild(field);
  });
}

function flattenObject(obj, prefix) {
  const results = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      results.push(...flattenObject(v, key));
    } else {
      results.push({ key, value: v });
    }
  }
  return results;
}

// ===== Raw JSON Render =====
function renderRaw(data) {
  rawJson.innerHTML = syntaxHighlight(JSON.stringify(data, null, 2));
}

function syntaxHighlight(json) {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, match => {
      if (/^"/.test(match)) return /:$/.test(match) ? `<span class="json-key">${match}</span>` : `<span class="json-string">${match}</span>`;
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
      if (/null/.test(match)) return `<span class="json-null">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    });
}

// ===== Tab Switching =====
function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

// ===== Copy JSON =====
function copyJSON() {
  if (!lastData) return;
  navigator.clipboard.writeText(JSON.stringify(lastData, null, 2)).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy JSON', 2000);
  });
}

// ===== Dark / Light Theme Toggle =====
(function() {
  const toggle = document.getElementById('themeToggle');
  const saved = localStorage.getItem('hon-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  toggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('hon-theme', next);
  });
})();

// ===== Fade-in on Scroll (Intersection Observer) =====
(function() {
  const sections = document.querySelectorAll('.fade-section');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible-anim');
      }
    });
  }, { threshold: 0.08 });
  sections.forEach(s => observer.observe(s));

  const mo = new MutationObserver(() => {
    document.querySelectorAll('.fade-section:not(.visible-anim)').forEach(s => observer.observe(s));
  });
  mo.observe(document.querySelector('.container'), { childList: true, subtree: true, attributes: true });
})();
