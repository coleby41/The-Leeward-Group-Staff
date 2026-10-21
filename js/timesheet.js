// ============================================================
// COMBINED DASHBOARD SCRIPT
// Merged from two source files:
//   - Timesheet / payroll schedule / announcements logic
//   - Header profile / nav access / sign-out / notifications logic
// Plus: My Documents (Supabase-backed upload/list/delete)
// ============================================================

// ---- UI only — no backend calls beyond what's already wired below. ----

/* ===========================
   ANNOUNCEMENTS FROM ACCOUNTING (Supabase)
   Uses window.supabaseClient, exposed globally by supabase-auth.js.
   Reads the same `announcements` table that payroll-tools.html writes to.
=========================== */

// Temporary announcements (see payroll-tools.html) carry an expires_at 24h
// out; long-term ones have expires_at = null and never expire on their own.
// There's no server-side cron for this — every reader opportunistically
// deletes anything past its expires_at before selecting, so an expired
// temporary announcement disappears the next time anyone loads a page that
// shows announcements.
async function getAnnouncements() {
  if (!window.supabaseClient) { console.error('Supabase client not ready yet'); return []; }
  const { error: purgeError } = await window.supabaseClient
    .from('announcements')
    .delete()
    .lt('expires_at', new Date().toISOString());
  if (purgeError) console.error('Failed to purge expired announcements:', purgeError);

  const { data, error } = await window.supabaseClient
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { console.error('Failed to load announcements:', error); return []; }
  return data;
}

// Renders the announcements card. Call on load and whenever announcements might have changed.
async function renderAnnouncements() {
  const items = await getAnnouncements();
  const wrap = document.getElementById('announcementsWrap');
  const container = document.getElementById('announcementsList');
  if (!items || items.length === 0) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'block';
  container.innerHTML = '';
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'announcement-item';
    div.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.message)}</p>
      <div class="announcement-date">${new Date(item.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>
    `;
    container.appendChild(div);
  });
}

/* ============================================================================
   MY TIMESHEET (Supabase)
   Tables: payroll_employees, timesheets, timesheet_entries, timesheet_events
   (see supabase-timesheet-workflow-setup.sql). Pay period helpers
   (loadPayPeriods, getCurrentPayPeriod, ppParseDate, ppFormatLong, etc.) come
   from pay-periods-shared.js, loaded before this file.

   One timesheet row is created per payroll_employee per pay_period, the
   first time the employee saves a draft or submits. Before that, the status
   shown is just "Not Started" client-side — there's nothing in the database
   yet for that period.
============================================================================ */

let myPayrollEmployeeId = null;
let myCurrentTimesheet = null; // row from `timesheets`, or null if not created yet this period
let myEntriesByDate = {};      // 'YYYY-MM-DD' -> timesheet_entries row

const STATUS_LABEL_TO_CLASS = {
  'Not Started': 'ts-not-started',
  'In Progress': 'ts-in-progress',
  'Submitted': 'ts-submitted',
  'Needs Corrections': 'ts-needs-corrections',
  'Sent to Accounting': 'ts-sent-to-accounting',
  'Processed': 'ts-processed',
  'Complete': 'ts-complete'
};

function timesheetIsEditable() {
  const status = myCurrentTimesheet ? myCurrentTimesheet.status : 'Not Started';
  return status === 'Not Started' || status === 'In Progress' || status === 'Needs Corrections';
}

async function initMyTimesheet() {
  const wrap = document.getElementById('timesheetGridWrap');
  const noPayrollMsg = document.getElementById('timesheetNoPayrollMsg');
  const noPeriodMsg = document.getElementById('timesheetNoPeriodMsg');
  if (!wrap) return; // this page's markup isn't present (shouldn't happen, but stay safe)

  wrap.style.display = 'none';
  noPayrollMsg.style.display = 'none';
  noPeriodMsg.style.display = 'none';

  const profile = getAvailableProfile();
  const staffId = profile?.id || profile?.uid;
  if (!staffId || !window.supabaseClient) return; // pollForProfile will call this again once ready

  await loadPayPeriods();
  const period = getCurrentPayPeriod();
  if (!period) { noPeriodMsg.style.display = 'block'; return; }

  const { data: payrollRow, error: payrollError } = await window.supabaseClient
    .from('payroll_employees')
    .select('*')
    .eq('staff_id', staffId)
    .maybeSingle();
  if (payrollError) console.error('Failed to load payroll record:', payrollError);
  if (!payrollRow) { noPayrollMsg.style.display = 'block'; updateMetrics({ weekHours: 0 }); return; }

  myPayrollEmployeeId = payrollRow.id;
  updateMetrics({ hourlyRate: payrollRow.hourly_rate });

  const { data: ts, error: tsError } = await window.supabaseClient
    .from('timesheets')
    .select('*')
    .eq('payroll_employee_id', myPayrollEmployeeId)
    .eq('pay_period_id', period.id)
    .maybeSingle();
  if (tsError) console.error('Failed to load timesheet:', tsError);
  myCurrentTimesheet = ts || null;

  myEntriesByDate = {};
  if (myCurrentTimesheet) {
    const { data: entries, error: entriesError } = await window.supabaseClient
      .from('timesheet_entries')
      .select('*')
      .eq('timesheet_id', myCurrentTimesheet.id);
    if (entriesError) console.error('Failed to load timesheet entries:', entriesError);
    (entries || []).forEach(e => { myEntriesByDate[e.work_date] = e; });
  }

  wrap.style.display = 'block';
  renderTimesheetStatusChip();
  await renderCorrectionsBanner();
  renderTimesheetGrid(period);
}

function renderTimesheetStatusChip() {
  const chip = document.getElementById('timesheetStatusChip');
  if (!chip) return;
  const status = myCurrentTimesheet ? myCurrentTimesheet.status : 'Not Started';
  chip.textContent = status;
  chip.className = `status ${STATUS_LABEL_TO_CLASS[status] || 'ts-not-started'}`;
}

// Shows the manager's most recent rejection comment when the timesheet has
// been sent back for corrections — pulled from timesheet_events rather than
// a single "latest comment" column, since every reject/comment is logged
// there as part of the full audit trail (see supabase-timesheet-workflow-setup.sql).
async function renderCorrectionsBanner() {
  const banner = document.getElementById('timesheetCorrectionsBanner');
  if (!banner) return;
  if (!myCurrentTimesheet || myCurrentTimesheet.status !== 'Needs Corrections') {
    banner.style.display = 'none';
    return;
  }

  const { data, error } = await window.supabaseClient
    .from('timesheet_events')
    .select('*')
    .eq('timesheet_id', myCurrentTimesheet.id)
    .eq('event_type', 'rejected')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) console.error('Failed to load correction note:', error);

  const note = data && data[0];
  banner.innerHTML = `<strong>Your manager sent this back for corrections.</strong>${note && note.comment ? escapeHtml(note.comment) : 'Edit your hours below and resubmit.'}`;
  banner.style.display = 'block';
}

function dateRangeForPeriod(period) {
  const dates = [];
  let cur = ppParseDate(period.start_date);
  const end = ppParseDate(period.end_date);
  while (cur <= end) {
    const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    dates.push(iso);
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return dates;
}

function renderTimesheetGrid(period) {
  const periodLabel = document.getElementById('timesheetPeriodLabel');
  const body = document.getElementById('timesheetGridBody');
  const saveBtn = document.getElementById('saveDraftBtn');
  const submitBtn = document.getElementById('submitTimesheetBtn');
  if (!body) return;

  if (periodLabel) {
    periodLabel.textContent = `${ppFormatLong(ppParseDate(period.start_date))} – ${ppFormatLong(ppParseDate(period.end_date))}`;
  }

  const editable = timesheetIsEditable();
  const dates = dateRangeForPeriod(period);

  body.innerHTML = dates.map(dateIso => {
    const entry = myEntriesByDate[dateIso] || {};
    const dayLabel = ppParseDate(dateIso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `
      <tr data-date="${dateIso}">
        <td>${dayLabel}</td>
        <td><input type="time" class="time-input" value="${entry.clock_in || ''}" data-field="clock_in" onchange="recalcTimesheetTotal()" ${editable ? '' : 'disabled'}></td>
        <td><input type="time" class="time-input" value="${entry.clock_out || ''}" data-field="clock_out" onchange="recalcTimesheetTotal()" ${editable ? '' : 'disabled'}></td>
        <td data-regular-display>0.00</td>
        <td><input type="number" class="hours-input" min="0" step="0.25" value="${entry.overtime_hours || ''}" data-field="overtime_hours" onchange="recalcTimesheetTotal()" ${editable ? '' : 'disabled'}></td>
        <td><input type="text" class="notes-input" value="${escapeHtml(entry.notes || '')}" data-field="notes" placeholder="Optional" ${editable ? '' : 'disabled'}></td>
      </tr>
    `;
  }).join('');

  if (saveBtn) saveBtn.style.display = editable ? 'inline-flex' : 'none';
  if (submitBtn) {
    submitBtn.style.display = editable ? 'inline-flex' : 'none';
    submitBtn.textContent = myCurrentTimesheet && myCurrentTimesheet.status === 'Needs Corrections' ? 'Resubmit Timesheet' : 'Submit Timesheet';
  }

  recalcTimesheetTotal();
}

// Regular hours are derived from clock in/out rather than typed — out minus
// in, in hours. If clock-out is earlier than clock-in, treats it as an
// overnight shift (adds 24h) rather than a negative number. Either field
// missing (still on shift, or not started) means 0 for now.
function computeRegularHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return 0;
  const [inH, inM] = clockIn.split(':').map(Number);
  const [outH, outM] = clockOut.split(':').map(Number);
  let minutes = (outH * 60 + outM) - (inH * 60 + inM);
  if (minutes < 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 100) / 100;
}

function collectTimesheetGridValues() {
  const rows = document.querySelectorAll('#timesheetGridBody tr[data-date]');
  return Array.from(rows).map(tr => {
    const workDate = tr.getAttribute('data-date');
    const get = (field) => tr.querySelector(`[data-field="${field}"]`);
    const clockIn = get('clock_in').value || null;
    const clockOut = get('clock_out').value || null;
    return {
      work_date: workDate,
      clock_in: clockIn,
      clock_out: clockOut,
      regular_hours: computeRegularHours(clockIn, clockOut),
      overtime_hours: parseFloat(get('overtime_hours').value) || 0,
      notes: get('notes').value.trim()
    };
  });
}

function recalcTimesheetTotal() {
  const totalEl = document.getElementById('timesheetGridTotal');
  const rows = collectTimesheetGridValues();

  // Refresh each row's computed "Regular" display cell to match its
  // current clock in/out inputs (these aren't typed directly, so nothing
  // else keeps them in sync).
  document.querySelectorAll('#timesheetGridBody tr[data-date]').forEach((tr, i) => {
    const cell = tr.querySelector('[data-regular-display]');
    if (cell) cell.textContent = rows[i].regular_hours.toFixed(2);
  });

  const total = rows.reduce((sum, r) => sum + r.regular_hours + r.overtime_hours, 0);
  if (totalEl) totalEl.textContent = `Total hours: ${total.toFixed(2)}`;
  updateMetrics({ weekHours: total });
  return total;
}

// Creates the timesheet row (status 'In Progress') the first time this is
// called for a period, then upserts every day's entry. Safe to call
// repeatedly — used by both "Save Draft" and as the first step of Submit.
async function saveTimesheetDraft(silent) {
  const msg = document.getElementById('timesheetMsg');
  if (!myPayrollEmployeeId) return false;
  const period = getCurrentPayPeriod();
  if (!period) return false;

  if (!myCurrentTimesheet) {
    const { data, error } = await window.supabaseClient
      .from('timesheets')
      .insert({ payroll_employee_id: myPayrollEmployeeId, pay_period_id: period.id, status: 'In Progress' })
      .select()
      .single();
    if (error) { console.error('Failed to start timesheet:', error); if (msg) { msg.textContent = 'Something went wrong saving that.'; msg.className = 'auth-message error'; } return false; }
    myCurrentTimesheet = data;
  }

  const rows = collectTimesheetGridValues().map(r => ({ ...r, timesheet_id: myCurrentTimesheet.id }));
  const { error: upsertError } = await window.supabaseClient
    .from('timesheet_entries')
    .upsert(rows, { onConflict: 'timesheet_id,work_date' });
  if (upsertError) { console.error('Failed to save timesheet entries:', upsertError); if (msg) { msg.textContent = 'Something went wrong saving your hours.'; msg.className = 'auth-message error'; } return false; }

  if (!silent && msg) { msg.textContent = 'Draft saved.'; msg.className = 'auth-message success'; }
  if (!silent) window.showToast?.('Draft saved.'); // shared bottom-right popup (js/toast.js)
  renderTimesheetStatusChip();
  return true;
}

async function submitTimesheet() {
  const msg = document.getElementById('timesheetMsg');
  const total = recalcTimesheetTotal();
  if (total <= 0) { if (msg) { msg.textContent = 'Enter some hours before submitting.'; msg.className = 'auth-message error'; } return; }

  const saved = await saveTimesheetDraft(true);
  if (!saved || !myCurrentTimesheet) return;

  const profile = getAvailableProfile();
  const actorId = profile?.id || profile?.uid || null;

  const { error } = await window.supabaseClient
    .from('timesheets')
    .update({ status: 'Submitted', submitted_at: new Date().toISOString() })
    .eq('id', myCurrentTimesheet.id);
  if (error) { console.error('Failed to submit timesheet:', error); if (msg) { msg.textContent = 'Something went wrong submitting that.'; msg.className = 'auth-message error'; } return; }

  await window.supabaseClient.from('timesheet_events').insert({
    timesheet_id: myCurrentTimesheet.id, event_type: 'submitted', actor_id: actorId
  });

  // No PDF gets generated here — per Coleby: nothing is produced until
  // employee + manager have both signed AND Accounting has finished
  // processing (see payroll-pdf-stub.js / markTimesheetComplete() in
  // payroll-tools.js for where that actually happens). The employee just
  // gets a confirmation notice for now.
  await window.supabaseClient.from('notifications').insert({
    user_id: actorId,
    title: 'Timesheet submitted',
    message: 'Your timesheet was submitted and is awaiting your manager\'s approval. No PDF is generated until it\'s fully processed.',
    type: 'timesheet'
  });

  // Let the manager know something's waiting on them too, so they don't
  // have to keep checking the Manage Employees page. profile.manager_id
  // comes straight off the staff_users row (added alongside `role` — see
  // supabase-timesheet-workflow-setup.sql).
  if (profile?.manager_id) {
    await window.supabaseClient.from('notifications').insert({
      user_id: profile.manager_id,
      title: 'Timesheet awaiting your review',
      message: `${profile.full_name || profile.username || 'An employee'} submitted a timesheet for approval.`,
      type: 'timesheet'
    });
  }

  myCurrentTimesheet.status = 'Submitted';
  if (msg) { msg.textContent = 'Submitted — awaiting manager approval.'; msg.className = 'auth-message success'; }
  window.showToast?.('Timesheet submitted — awaiting manager approval.');
  renderTimesheetStatusChip();
  document.getElementById('timesheetCorrectionsBanner').style.display = 'none';
  renderTimesheetGrid(getCurrentPayPeriod());
}

/* ===========================
   MY DOCUMENTS (Supabase)
   Table: staff_documents (RLS: user_id = auth.uid())
   Bucket: staff-documents (private; path = {user_id}/{uuid}-{filename})
=========================== */

const ALLOWED_DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic'];
const MAX_DOC_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const CATEGORY_LABELS = { w2: 'W-2 Tax Form', w4: 'W-4 Tax Form', '1099': '1099 Tax Form', other: 'Other Form', timesheet: 'Timesheet' };

async function loadDocuments() {
  if (!window.supabaseClient) { console.error('Supabase client not ready yet'); return; }

  const profile = getAvailableProfile();
  const userId = profile?.id || profile?.uid;
  if (!userId) { console.warn('No user id yet — skipping document load'); return; }

  const { data, error } = await window.supabaseClient
    .from('staff_documents')
    .select('*')
    .eq('user_id', userId)
    .order('uploaded_at', { ascending: false });

  if (error) { console.error('Failed to load documents:', error); return; }

  await renderDocuments(data || []);
}

async function uploadDoc() {
  const fileInput = document.getElementById('docFile');
  const category = document.getElementById('docCategory').value;
  const msg = document.getElementById('docMsg');
  const file = fileInput.files[0];

  if (!file) { msg.textContent = 'Choose a file first.'; msg.className = 'msg error'; return; }
  if (!ALLOWED_DOC_TYPES.includes(file.type)) {
    msg.textContent = 'Only PDF or image files (JPG, PNG, HEIC) are allowed.';
    msg.className = 'msg error';
    return;
  }
  if (file.size > MAX_DOC_SIZE_BYTES) {
    msg.textContent = 'File is too large (10MB max).';
    msg.className = 'msg error';
    return;
  }

  const profile = getAvailableProfile();
  const userId = profile?.id || profile?.uid;
  if (!userId) { msg.textContent = 'Still loading your profile — try again in a moment.'; msg.className = 'msg error'; return; }

  msg.textContent = 'Uploading...';
  msg.className = 'msg';

  const filePath = `${userId}/${crypto.randomUUID()}-${file.name}`;

  const { error: uploadError } = await window.supabaseClient
    .storage
    .from('staff-documents')
    .upload(filePath, file);

  if (uploadError) {
    console.error('Storage upload failed:', uploadError);
    msg.textContent = 'Upload failed. Please try again.';
    msg.className = 'msg error';
    return;
  }

  const { error: insertError } = await window.supabaseClient
    .from('staff_documents')
    .insert({
      user_id: userId,
      file_name: file.name,
      file_path: filePath,
      category
    });

  if (insertError) {
    console.error('Failed to save document record:', insertError);
    // Clean up the orphaned storage file since the DB row failed
    await window.supabaseClient.storage.from('staff-documents').remove([filePath]);
    msg.textContent = 'Upload failed. Please try again.';
    msg.className = 'msg error';
    return;
  }

  fileInput.value = '';
  msg.textContent = 'Uploaded successfully.';
  msg.className = 'msg success';
  window.showToast?.('Uploaded successfully.'); // shared bottom-right popup (js/toast.js)
  loadDocuments();
}

async function deleteDoc(id, filePath) {
  if (!confirm('Delete this document? This cannot be undone.')) return;

  const { error: storageError } = await window.supabaseClient
    .storage
    .from('staff-documents')
    .remove([filePath]);

  if (storageError) { console.error('Failed to delete file from storage:', storageError); }

  const { error: dbError } = await window.supabaseClient
    .from('staff_documents')
    .delete()
    .eq('id', id);

  if (dbError) {
    console.error('Failed to delete document record:', dbError);
    return;
  }

  loadDocuments();
}

async function renderDocuments(docs) {
  const list = document.getElementById('docList');
  const empty = document.getElementById('docEmpty');
  list.innerHTML = '';

  if (!docs || docs.length === 0) {
    empty.style.display = 'block';
    updateMetrics({ docCount: 0 });
    return;
  }
  empty.style.display = 'none';

  for (const doc of docs) {
    const { data: signedUrlData, error } = await window.supabaseClient
      .storage
      .from('staff-documents')
      .createSignedUrl(doc.file_path, 60); // link valid for 60 seconds

    const url = error ? '#' : signedUrlData.signedUrl;

    const div = document.createElement('div');
    div.className = 'doc-item';
    div.innerHTML = `
      <div>
        <h3>${escapeHtml(doc.file_name)}</h3>
        <p>${escapeHtml(CATEGORY_LABELS[doc.category] || doc.category)} · ${new Date(doc.uploaded_at).toLocaleDateString()}</p>
      </div>
      <div style="display:flex; gap:6px;">
        <button type="button" class="btn small secondary" data-preview-url="${escapeHtml(url)}" data-preview-name="${escapeHtml(doc.file_name)}">Open</button>
        <button class="btn small danger" onclick="deleteDoc('${doc.id}', '${doc.file_path}')">Delete</button>
      </div>
    `;
    list.appendChild(div);
  }

  updateMetrics({ docCount: docs.length });
}

/* ===========================
   METRICS (merges instead of overwriting, since hours/docs/pending
   are updated independently by different loaders)
=========================== */

let metricsState = { weekHours: 0, hourlyRate: null, docCount: 0 };

function updateMetrics(partial = {}) {
  metricsState = { ...metricsState, ...partial };
  document.getElementById('metricHours').textContent = metricsState.weekHours.toFixed(1);
  document.getElementById('metricPending').textContent = metricsState.hourlyRate != null ? `$${Number(metricsState.hourlyRate).toFixed(2)}/hr` : '—';
  document.getElementById('metricDocs').textContent = metricsState.docCount;
}

// Shared HTML-escaping helper (used by draft/timesheet/document/announcement/notification renderers)
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

/* ===========================
   SIGN OUT
=========================== */

const signOutButton = document.getElementById('signOutButton');

if (signOutButton) {
  signOutButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (typeof window.signOutUser === 'function') {
      window.signOutUser();
    } else {
      console.error('signOutUser() is not available');
    }
  });
}

/* ===========================
   ELEMENTS - header/profile
=========================== */

const userNameElement = document.getElementById('headerUserName');
const welcomeHeading = document.getElementById('welcomeHeading');
const adminNavGroup = document.getElementById('adminNavGroup');
const brandInitials = document.getElementById('brandInitials');

/* ===========================
   UPDATE STAFF NAME
=========================== */

function updateStaffName(profile) {
  if (!profile) return;

  const name = profile.full_name || profile.username || 'Staff';

  // Update only the text so the bell does not disappear
  if (userNameElement) {
    userNameElement.textContent = name;
  }

  if (welcomeHeading) {
    welcomeHeading.textContent = `Welcome, ${name}`;
  }

  if (brandInitials) {
    const words = String(name).trim().split(/\s+/).filter(Boolean);
    const initials = words.length >= 2
      ? `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
      : words[0]?.substring(0, 2).toUpperCase() || 'ST';
    brandInitials.textContent = initials;
  }

  const sidebarGroupPill = document.getElementById('sidebarGroupPill');
  if (sidebarGroupPill) {
    const groups = window.getSupabaseUserGroups ? window.getSupabaseUserGroups(profile) : [];
    sidebarGroupPill.textContent = groups.length
      ? groups.map(g => g.charAt(0).toUpperCase() + g.slice(1)).join(', ')
      : 'No Group';
  }
}

/* ===========================
   NAV ACCESS
=========================== */

function updateNavAccess(profile) {
  const shouldShowAdminNav = window.isSupabaseUserInGroup
    ? (window.isSupabaseUserInGroup(profile, 'IT') || window.isSupabaseUserInGroup(profile, 'Super Admin'))
    : false;

  if (adminNavGroup) {
    adminNavGroup.style.display = shouldShowAdminNav ? 'block' : 'none';
  }

  const payrollToolsNavItem = document.getElementById('payrollToolsNavItem');

  // Payroll Tools is visible to the Office and Accounting workgroups (plus Super Admin).
  const shouldShowPayrollTools = window.isSupabaseUserInGroup
    ? (
        window.isSupabaseUserInGroup(profile, 'Office') ||
        window.isSupabaseUserInGroup(profile, 'Accounting') ||
        window.isSupabaseUserInGroup(profile, 'Super Admin')
      )
    : false;

  if (payrollToolsNavItem) {
    payrollToolsNavItem.style.display = shouldShowPayrollTools ? 'flex' : 'none';
  }
}

/* ===========================
   LOAD PROFILE (with retry/poll)
   window.currentSupabaseProfile is only populated by supabase-auth.js during
   an active sign-in — on a normal page load/reload it's undefined, so the
   fallback is whatever was cached in localStorage.staffProfile at sign-in
   time. That fallback is normally enough by itself, but if auth-guard.js (or
   anything else validating the session) writes/refreshes that value slightly
   after this script's DOMContentLoaded check runs, a single check can still
   miss it. To be safe regardless of that timing, we poll for a few seconds
   instead of checking exactly once.
=========================== */

let profileInitDone = false;

function getStoredProfile() {
  try {
    return JSON.parse(localStorage.getItem('staffProfile') || 'null');
  } catch (error) {
    console.warn('Unable to parse stored profile:', error);
    return null;
  }
}

function getAvailableProfile() {
  return window.currentSupabaseProfile || getStoredProfile();
}

function applyProfileIfAvailable() {
  const profile = getAvailableProfile();
  if (profile) {
    updateStaffName(profile);
    updateNavAccess(profile);
    profileInitDone = true;
  }
  return profile;
}

// Tries immediately, then retries every 200ms for up to ~5s (25 attempts).
function pollForProfile(maxAttempts = 25, intervalMs = 200) {
  if (applyProfileIfAvailable()) {
    loadDocuments();    // profile was already available — safe to load docs now
    initMyTimesheet();  // ...and to load this employee's timesheet
    return;
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    const profile = applyProfileIfAvailable();
    if (profile || attempts >= maxAttempts) {
      clearInterval(timer);
      if (profile) {
        loadDocuments();    // profile just became available — load docs now
        initMyTimesheet();  // ...and this employee's timesheet
      } else if (!profileInitDone) {
        console.warn('No staff profile found after waiting — name/nav may not reflect the signed-in user. Check that localStorage.staffProfile is being set (e.g. by auth-guard.js) on this page.');
      }
    }
  }, intervalMs);
}

/* ===========================
   NOTIFICATIONS
   Now handled by the shared notifications.js (loaded via <script src> in
   time sheet.html), which self-initializes and persists read state to
   Supabase instead of localStorage. See notifications.js.
=========================== */

/* ===========================
   PAGE INIT
=========================== */

window.addEventListener('DOMContentLoaded', function () {
  pollForProfile();        // retries for a few seconds until the profile shows up; loads docs + timesheet once found
  renderAnnouncements();   // shows any messages Accounting has sent
});
// Document "Open" buttons preview in the portal (never a new tab).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preview-url]');
  if (!btn || btn.dataset.previewUrl === '#') return;
  window.FilePreview.open({ name: btn.dataset.previewName, url: btn.dataset.previewUrl });
});
