const userSearch = document.getElementById('userSearch');
const userList = document.getElementById('userList');
const userCount = document.getElementById('userCount');
const staffUsersContent = document.getElementById('staffUsersContent');
const restrictedView = document.getElementById('restrictedView');
const userModalOverlay = document.getElementById('userModalOverlay');
const userModalTitle = document.getElementById('userModalTitle');
const userModalSubtitle = document.getElementById('userModalSubtitle');
const closeUserModalBtn = document.getElementById('closeUserModalBtn');
const userFormMessage = document.getElementById('userFormMessage');
const generatePasswordBtn = document.getElementById('generatePasswordBtn');
const generatedPasswordBox = document.getElementById('generatedPasswordBox');
const generatedPasswordValue = document.getElementById('generatedPasswordValue');
const generatedPasswordLinks = document.getElementById('generatedPasswordLinks');
const copyPasswordBtn = document.getElementById('copyPasswordBtn');
const regeneratePasswordBtn = document.getElementById('regeneratePasswordBtn');
const clearPasswordBtn = document.getElementById('clearPasswordBtn');
const passwordNote = document.getElementById('passwordNote');
const passwordSection = document.getElementById('passwordSection');
const userDetailsForm = document.getElementById('userDetailsForm');
const selectedUserIdInput = document.getElementById('selectedUserId');
const fullNameInput = document.getElementById('fullName');
const usernameInput = document.getElementById('username');
const groupInput = document.getElementById('group');
const passwordInput = document.getElementById('password');
const staffRoleInput = document.getElementById('staffRole');
const staffManagerInput = document.getElementById('staffManager');
const employeeCodeInput = document.getElementById('employeeCode');
const accountNotesInput = document.getElementById('accountNotes');
const toggleActiveBtn = document.getElementById('toggleActiveBtn');
const directoryMessage = document.getElementById('directoryMessage');

let supabaseClient = null;
let allUsers = [];
let filteredUsers = [];
let selectedUserId = null;

function getSupabaseClient() {
  // Reuse the single shared client supabase-auth.js creates and keeps a
  // real, authenticated Supabase Auth session on — this file used to create
  // its OWN separate client instance here, which under real Supabase Auth
  // risks two GoTrueClient instances competing over the same session
  // storage (Supabase explicitly warns against this). window.supabaseClient
  // is set synchronously by supabase-auth.js before this file's script tag
  // runs (same load order as every other page), so it should already exist.
  supabaseClient = window.supabaseClient || supabaseClient;
  return supabaseClient;
}

function setMessage(element, text, type) {
  if (!element) return;
  element.textContent = text;
  if (element === directoryMessage) {
    element.className = `workbook-page-message ${type}`;
    element.style.display = text ? '' : 'none';
  } else {
    element.className = `auth-message ${type}`;
  }
}

function esc(value) {
  const d = document.createElement('div');
  d.textContent = value ?? '';
  return d.innerHTML;
}

function staffCan(permissionKey) {
  return window.Permissions ? window.Permissions.hasPermission(permissionKey) : true;
}

function getStoredProfile() {
  try {
    const storedProfile = localStorage.getItem('staffProfile');
    return storedProfile ? JSON.parse(storedProfile) : null;
  } catch (error) {
    console.warn('Unable to load stored profile:', error);
    return null;
  }
}

// Resets someone else's real Supabase Auth password via the
// reset-staff-password Edge Function (service-role key server-side,
// IT/Super-Admin check on the caller). Writing password_hash directly (the
// old approach) no longer does anything real — login goes through Supabase
// Auth now, not that column — so this replaces that write entirely.
async function resetPasswordViaFunction(staffUserId, newPassword) {
  const config = window.SUPABASE_CONFIG || {};
  const client = getSupabaseClient();
  if (!client) return { error: 'Unable to reach the server. Try again.' };

  const { data: sessionData } = await client.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) return { error: 'Your session has expired. Please sign in again.' };

  let response;
  try {
    response = await fetch(`${config.url}/functions/v1/reset-staff-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ staff_user_id: staffUserId, new_password: newPassword }),
    });
  } catch (networkError) {
    console.error('resetPasswordViaFunction: network error', networkError);
    return { error: 'Unable to reach the server. Try again.' };
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) {
    return { error: result.error || 'Unable to reset that password.' };
  }
  return { ok: true };
}

// New passwords are generated, never typed. 14 characters from a set with
// no look-alikes (no 0/O, 1/l/I), always at least one upper, lower, digit
// and symbol. crypto.getRandomValues with rejection sampling = no bias.
const PW_SETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?'];

function randomIndex(max) {
  const limit = Math.floor(256 / max) * max;
  const byte = new Uint8Array(1);
  do { crypto.getRandomValues(byte); } while (byte[0] >= limit);
  return byte[0] % max;
}

function generatePassword(length = 14) {
  const all = PW_SETS.join('');
  const chars = PW_SETS.map((set) => set[randomIndex(set.length)]);
  while (chars.length < length) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function setGeneratedPassword(value) {
  if (passwordInput) passwordInput.value = value || '';
  const has = Boolean(value);
  if (generatedPasswordValue) generatedPasswordValue.textContent = value || '';
  generatedPasswordBox?.classList.toggle('hidden', !has);
  generatedPasswordLinks?.classList.toggle('hidden', !has);
  generatePasswordBtn?.classList.toggle('hidden', has);
  if (copyPasswordBtn) copyPasswordBtn.textContent = 'Copy';
  if (passwordNote) {
    passwordNote.textContent = has
      ? 'Copy it now — it’s set when you click Save changes. Give it to them directly (in person or a DM), not by email.'
      : 'Their current password stays the same unless you generate a new one.';
  }
}

async function hashPassword(password) {
  const passwordBuffer = new TextEncoder().encode(password);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', passwordBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function managerName(managerId) {
  if (!managerId) return '—';
  const manager = allUsers.find((user) => String(user.id) === String(managerId));
  return manager ? (manager.full_name || manager.username || '—') : '—';
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length >= 2 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2)).toUpperCase();
}

// Same look as the vendor profile's tables (.vd-panel / .vd-table).
// Phones (≤768px, CSS only): just the name, with a chevron — tapping a row
// opens the edit popup.
function renderUserList(users) {
  if (!userList) return;
  if (!users.length) {
    userList.innerHTML = `<tr class="su-empty"><td colspan="6">${allUsers.length ? 'No users match that search.' : 'No staff users found.'}</td></tr>`;
    return;
  }

  userList.innerHTML = users.map((user) => {
    const groups = Array.isArray(user.workgroup) ? user.workgroup.join(', ') : user.workgroup || '—';
    const isActive = user.active !== false;
    const name = user.full_name || user.username || 'Unnamed';
    const manager = managerName(user.manager_id);
    return `
      <tr class="${isActive ? '' : 'su-tr-inactive'}" data-user-id="${esc(user.id)}" tabindex="0" role="button" aria-label="Edit ${esc(name)}">
        <td class="vd-td-main"><div class="vd-name"><span class="vd-avatar">${esc(initials(name))}</span><div class="vd-name__text">
          <div class="vd-name__line"><span class="su-name">${esc(name)}</span>${user.role === 'Manager' ? ' <span class="vd-pill vd-pill--portal">Manager</span>' : ''}${isActive ? '' : ' <span class="vd-pill vd-pill--none">Inactive</span>'}</div>
          <span class="vd-muted">${esc(user.username || '—')}</span>
        </div></div></td>
        <td data-label="Group">${esc(groups)}</td>
        <td data-label="Role">${esc(user.role || 'Employee')}</td>
        <td data-label="Manager">${manager === '—' ? '<span class="vd-muted">—</span>' : esc(manager)}</td>
        <td data-label="Status"><span class="vd-status ${isActive ? 'vd-status--ok' : 'vd-status--bad'}">${isActive ? 'Active' : 'Inactive'}</span></td>
        <td class="is-right"><span class="su-chevron" aria-hidden="true">›</span></td>
      </tr>
    `;
  }).join('');
}

function updateCount() {
  const total = allUsers.length;
  const active = allUsers.filter((user) => user.active !== false).length;
  if (userCount) userCount.textContent = String(total);
  const activeEl = document.getElementById('userActiveCount');
  if (activeEl) activeEl.textContent = total ? `· ${active} active` : '';
}

function openUserModal(user) {
  if (!user || !userModalOverlay) return;
  showDetailsForm(user);
  setMessage(userFormMessage, '', '');
  userModalOverlay.classList.remove('hidden');
  document.body.classList.add('popup-active');
}

function closeUserModal() {
  if (!userModalOverlay) return;
  userModalOverlay.classList.add('hidden');
  document.body.classList.remove('popup-active');
  selectedUserId = null;
}

// 2026-08-20: Group used to be a free-text input — the only place in the app
// someone's workgroup could be typed by hand instead of picked from the live
// Workgroups list, same fix already applied to admin-users.html's
// Create-a-staff-account form (populateGroupOptionsFromWorkgroups() there).
// The select ships with a hardcoded fallback list (Owner/Field/IT/Office/
// Accounting) so this page still works before supabase-workgroups-setup.sql
// has been run; once that migration exists this swaps in whatever's actually
// in the Workgroups tab, so a workgroup added there becomes selectable here
// automatically. Called once on page load — unlike admin-users.html's
// version, this doesn't need to preserve "the value someone was about to
// submit" (there's no in-progress selection yet at load time), it only needs
// to run before the first showDetailsForm() call so the real select has real
// options before anything tries to select one.
async function populateGroupOptionsFromWorkgroups() {
  if (!groupInput || !window.supabaseClient) return;

  const { data, error } = await window.supabaseClient
    .from('workgroups')
    .select('name')
    .order('name', { ascending: true });

  if (error || !data || !data.length) return; // fail open: keep the hardcoded fallback options

  const escapeHtml = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  };

  groupInput.innerHTML = data
    .map((wg) => `<option value="${escapeHtml(wg.name)}">${escapeHtml(wg.name)}</option>`)
    .join('');
}

// Guards against a real staff account's saved workgroup not being one of the
// live Workgroups options (a workgroup that's since been renamed/removed
// there, or any other legacy value) — a plain `select.value = x` silently
// does nothing if x isn't one of the <option>s, which here would show
// whatever option happened to be first instead of this person's real group,
// and then saving the form (which reads groupInput.value) would silently
// overwrite their real workgroup with that wrong one. Adding the value as its
// own option first means it always displays correctly and a save that
// doesn't touch this field can't corrupt it — the IT admin still sees an
// explicit "(not in Workgroups list)" marker if it's stale, rather than the
// page just quietly showing the wrong group.
function ensureGroupOption(value) {
  if (!groupInput || !value) return;
  const alreadyThere = Array.from(groupInput.options).some((opt) => opt.value === value);
  if (!alreadyThere) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = `${value} (not in Workgroups list)`;
    groupInput.appendChild(opt);
  }
}

// Rebuilds the Manager <select> from every other staff user (a user can't be
// their own manager). Called whenever allUsers refreshes and before setting
// staffManagerInput.value, since a <select> can't select a value that isn't
// one of its <option>s yet.
function populateManagerOptions() {
  if (!staffManagerInput) return;
  const currentValue = staffManagerInput.value;
  const options = allUsers
    .filter((user) => String(user.id) !== String(selectedUserId))
    .map((user) => `<option value="${esc(user.id)}">${esc(user.full_name || user.username || 'Unnamed')}</option>`)
    .join('');
  staffManagerInput.innerHTML = `<option value="">— None —</option>${options}`;
  staffManagerInput.value = currentValue;
}

function showDetailsForm(user) {
  if (!user) return;

  selectedUserId = user.id;
  if (userModalTitle) userModalTitle.textContent = user.full_name || user.username || 'Staff user';
  if (userModalSubtitle) {
    userModalSubtitle.textContent = `${user.username || '—'} · ${user.active === false ? 'Inactive' : 'Active'}`;
  }
  if (selectedUserIdInput) selectedUserIdInput.value = user.id || '';
  if (fullNameInput) fullNameInput.value = user.full_name || '';
  if (usernameInput) usernameInput.value = user.username || '';
  if (groupInput) {
    const groupValue = Array.isArray(user.workgroup) ? user.workgroup[0] || '' : user.workgroup || '';
    ensureGroupOption(groupValue);
    groupInput.value = groupValue;
  }
  setGeneratedPassword('');
  if (staffRoleInput) staffRoleInput.value = user.role || 'Employee';
  populateManagerOptions();
  if (staffManagerInput) staffManagerInput.value = user.manager_id || '';
  if (employeeCodeInput) employeeCodeInput.value = user.employee_code || '';
  if (accountNotesInput) {
    accountNotesInput.value = user.account_notes || '';
  }
  if (toggleActiveBtn) {
    toggleActiveBtn.textContent = user.active === false ? 'Reactivate' : 'Deactivate';
  }

  const canEditDetails = staffCan('staff.edit_account_details');
  [fullNameInput, usernameInput, groupInput, staffRoleInput, staffManagerInput, employeeCodeInput, accountNotesInput].forEach((el) => {
    if (el) el.disabled = !canEditDetails;
  });
  const saveBtn = document.getElementById('saveUserDetailsBtn');
  if (saveBtn) saveBtn.disabled = !canEditDetails;
  if (toggleActiveBtn) toggleActiveBtn.classList.toggle('hidden', !canEditDetails);

  if (passwordSection) passwordSection.classList.toggle('hidden', !staffCan('staff.reset_password'));
}

function applySearch(term) {
  const query = term.toLowerCase().trim();
  filteredUsers = query
    ? allUsers.filter((user) => [user.full_name, user.username, user.workgroup].some((value) => String(value || '').toLowerCase().includes(query)))
    : allUsers;
  renderUserList(filteredUsers);
}

async function loadStaffUsers() {
  const profile = getStoredProfile();

  const isAllowed =
    window.isSupabaseUserInGroup
      ? (
          window.isSupabaseUserInGroup(profile, "IT") ||
          window.isSupabaseUserInGroup(profile, "Super Admin")
        )
      : false;

  if (!isAllowed) {
    if (restrictedView) restrictedView.style.display = '';
    if (staffUsersContent) staffUsersContent.style.display = 'none';
    return;
  }

  if (restrictedView) restrictedView.style.display = 'none';
  if (staffUsersContent) staffUsersContent.style.display = '';

  const config = window.SUPABASE_CONFIG || {};
  if (!config.url || config.url === 'YOUR_SUPABASE_URL' || !config.anonKey || config.anonKey === 'YOUR_SUPABASE_ANON_KEY') {
    setMessage(directoryMessage, 'Supabase is not configured yet.', 'error');
    return;
  }

  const client = getSupabaseClient();
  // Reads go through staff_users_directory (a view that omits password_hash)
  // now that the base table's RLS no longer grants anon a direct SELECT —
  // see supabase-staff-users-rls-setup.sql. Writes below still target
  // staff_users directly, which is unaffected by this.
  const { data, error } = await client.from('staff_users_directory').select('*').order('created_at', { ascending: false });

  if (error) {
    setMessage(directoryMessage, error.message || 'Unable to load staff users.', 'error');
    return;
  }

  setMessage(directoryMessage, '', '');
  allUsers = (data || []).slice().sort((a, b) =>
    String(a.full_name || a.username || '').localeCompare(String(b.full_name || b.username || ''))
  );
  updateCount();
  applySearch(userSearch ? userSearch.value : '');
}

async function updateSelectedUser(updates) {
  if (!selectedUserId) return false;
  const client = getSupabaseClient();
  // Use { count: 'exact' } rather than .select() to detect zero-row updates.
  // .select() would ask PostgREST to read the row back after writing it,
  // which needs its own SELECT RLS grant — and staff_users deliberately has
  // none for anon (that's what keeps password_hash from being readable
  // directly; see supabase-staff-users-rls-setup.sql). count instead reflects
  // how many rows the UPDATE's own policy actually matched, with no read-back
  // required, so it can't be fooled by the missing SELECT policy.
  const { error, count } = await client
    .from('staff_users')
    .update(updates, { count: 'exact' })
    .eq('id', selectedUserId);
  if (error) {
    setMessage(userFormMessage, error.message || 'Unable to update user.', 'error');
    return false;
  }

  if (!count) {
    setMessage(userFormMessage, 'No changes were saved — the update matched 0 rows (likely a Supabase RLS permission issue on staff_users, or the selected user no longer exists).', 'error');
    return false;
  }

  setMessage(userFormMessage, 'User updated successfully.', 'success');
  window.showToast?.('User updated successfully.'); // shared bottom-right popup (js/toast.js)
  await loadStaffUsers();
  return true;
}

function openRow(row) {
  if (!row) return;
  const userId = row.getAttribute('data-user-id');
  const selectedUser = allUsers.find((user) => String(user.id) === String(userId));
  openUserModal(selectedUser);
}

userList.addEventListener('click', function (event) {
  openRow(event.target.closest('tr[data-user-id]'));
});

userList.addEventListener('keydown', function (event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('tr[data-user-id]');
  if (!row) return;
  event.preventDefault();
  openRow(row);
});

closeUserModalBtn?.addEventListener('click', closeUserModal);

generatePasswordBtn?.addEventListener('click', () => setGeneratedPassword(generatePassword()));
regeneratePasswordBtn?.addEventListener('click', () => setGeneratedPassword(generatePassword()));
clearPasswordBtn?.addEventListener('click', () => setGeneratedPassword(''));

copyPasswordBtn?.addEventListener('click', async function () {
  const value = passwordInput ? passwordInput.value : '';
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copyPasswordBtn.textContent = 'Copied';
  } catch (error) {
    // Clipboard blocked: select the text so it can be copied by hand.
    const range = document.createRange();
    range.selectNodeContents(generatedPasswordValue);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    copyPasswordBtn.textContent = 'Select & copy';
  }
});

// Tap the area behind the popup to close (also what a phone swipe-down
// falls back to — see sheet-swipe.js).
userModalOverlay?.addEventListener('click', function (event) {
  if (event.target === userModalOverlay) closeUserModal();
});

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && userModalOverlay && !userModalOverlay.classList.contains('hidden')) {
    closeUserModal();
  }
});

userSearch.addEventListener('input', function (event) {
  applySearch(event.target.value);
});

userDetailsForm.addEventListener('submit', async function (event) {
  event.preventDefault();

  if (!staffCan('staff.edit_account_details')) {
    setMessage(userFormMessage, "You don't have permission to do this.", 'error');
    return;
  }

  const updates = {
    full_name: fullNameInput.value.trim(),
    username: usernameInput.value.trim(),
    workgroup: [groupInput.value.trim() || 'Operations'],
    role: staffRoleInput ? staffRoleInput.value : 'Employee',
    manager_id: staffManagerInput && staffManagerInput.value ? staffManagerInput.value : null,
    employee_code: employeeCodeInput && employeeCodeInput.value.trim() ? employeeCodeInput.value.trim() : null,
    account_notes: accountNotesInput ? accountNotesInput.value.trim() : ''
  };

  const newPassword = passwordInput.value.trim();

  if (newPassword && !staffCan('staff.reset_password')) {
    setMessage(userFormMessage, "You don't have permission to reset passwords.", 'error');
    return;
  }

  const pendingPasswordReset = newPassword ? selectedUserId : null;
  let passwordWasReset = false;

  const savedFields = await updateSelectedUser(updates);

  if (pendingPasswordReset) {
    const result = await resetPasswordViaFunction(pendingPasswordReset, newPassword);
    if (result.error) {
      setMessage(userFormMessage, result.error, 'error');
    } else if (savedFields) {
      passwordWasReset = true;
      setMessage(userFormMessage, 'User updated and password reset successfully.', 'success');
      window.showToast?.('User updated and password reset successfully.');
    }
  }

  const refreshedUser = allUsers.find((user) => String(user.id) === String(selectedUserId));
  if (refreshedUser) {
    showDetailsForm(refreshedUser);
  }
  // Keep the new password on screen after the refresh so it can still be
  // copied — but cleared from the form, so another Save won't reset it again.
  if (passwordWasReset) {
    setGeneratedPassword(newPassword);
    if (passwordInput) passwordInput.value = '';
    generatedPasswordLinks?.classList.add('hidden');
    generatePasswordBtn?.classList.remove('hidden');
    if (passwordNote) passwordNote.textContent = 'Password changed. Copy it now — it won’t be shown again after you close this.';
  }
});

toggleActiveBtn.addEventListener('click', async function () {
  if (!selectedUserId) return;
  if (!staffCan('staff.edit_account_details')) return;
  const currentUser = allUsers.find((user) => String(user.id) === String(selectedUserId));
  if (!currentUser) return;
  const nextActiveState = currentUser.active === false;
  const ok = await updateSelectedUser({ active: nextActiveState });
  if (ok) {
    const refreshedUser = allUsers.find((user) => String(user.id) === String(selectedUserId));
    if (refreshedUser) showDetailsForm(refreshedUser);
  }
});

window.addEventListener('DOMContentLoaded', async function () {
  if (window.Permissions) {
    try { await window.Permissions.initPermissions(); } catch { /* staffCan() fails open regardless */ }
  }
  // Populate the live Workgroups list into the Group <select> before the
  // first showDetailsForm() call (inside loadStaffUsers) tries to select a
  // value into it — ensureGroupOption() still covers any per-user legacy
  // value even if this fails or hasn't loaded yet (fail-open, same as
  // admin-users.js's version).
  await populateGroupOptionsFromWorkgroups();
  await loadStaffUsers();
});