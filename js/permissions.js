/* ===========================
   PERMISSIONS (shared, every page)

   Reads the `permissions` / `workgroup_permissions` tables (see
   sql/supabase-permissions-system-setup.sql) and answers "can the
   signed-in person do X" for any of the granular permission keys catalogued
   there. This replaces workgroup_nav_access as the source of truth for
   nav-tab visibility (see nav-access.js) and is what the new Workgroups
   screen and the per-page right-click permission editor both read/write.

   IMPORTANT -- fails open on purpose, same convention as nav-access.js: if
   these tables don't exist yet (the SQL hasn't been run), every permission
   check below returns true so nothing breaks or silently locks anyone out
   before the migration has actually run.

   "Super Admin" always has every permission, regardless of what's in
   workgroup_permissions -- a hardcoded bypass, matching every other
   hardcoded Super Admin bypass already in this app (nav-access.js,
   workgroups.js). It is also seeded with every row for display purposes
   (so the Workgroups screen's grid shows it fully checked), but the
   bypass in isSuperAdmin() below is what actually enforces it -- the
   seeded rows are just so the UI is never lying about it.

   "Manager" (staff_users.role === 'Manager') is a personal attribute, not
   a workgroup, and stays that way here exactly like it does in
   manager-nav.js today: it additionally grants the manager.* permissions
   and general.view_manage_employees on top of whatever the person's real
   workgroup(s) say, via MANAGER_ROLE_BONUS_PERMISSIONS below.

   PREVIEW MODE: the Workgroups screen can put the browser into "preview as
   workgroup X" mode (see startPermissionPreview/exitPermissionPreview). While
   active, every permission check in the app answers as if the signed-in
   person's ONLY workgroup were the previewed one (Manager-role bonus
   permissions are suppressed during preview, since you're previewing a
   workgroup, not a specific person). A banner (renderPreviewBanner, wired
   into nav-access.js) makes it obvious preview mode is on and offers a way
   out. Preview state lives in sessionStorage so it doesn't leak between
   tabs or survive closing the browser, and is cleared automatically if the
   real signed-in person doesn't have general.manage_workgroups (so someone
   can't get stuck previewing after their own access changes).
=========================== */

const PERMISSION_PREVIEW_KEY = "permissionPreviewWorkgroup"; // sessionStorage key: { id, name }

let permissionsCatalogCache = null;   // [{ key, category, page_label, label, description, governed_by }]
let workgroupPermissionsCache = null; // Map<lowercase workgroup name, Set<permission_key>>
let permissionsLoadFailed = false;

function permGetProfile() {
    if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
    try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); }
    catch { return null; }
}

function isSuperAdminProfile(profile) {
    return window.isSupabaseUserInGroup ? window.isSupabaseUserInGroup(profile, "Super Admin") : false;
}

function isManagerRoleProfile(profile) {
    return String(profile?.role || "").trim().toLowerCase() === "manager";
}

// Permissions additionally granted to anyone with staff_users.role === 'Manager',
// on top of their real workgroup(s) -- mirrors manager-nav.js's existing behavior.
const MANAGER_ROLE_BONUS_PERMISSIONS = [
    "general.view_manage_employees",
    "manager.view_team_timesheets",
    "manager.approve_reject_timesheets",
    "manager.comment_on_timesheet",
];

function getPermissionPreview() {
    try {
        const raw = sessionStorage.getItem(PERMISSION_PREVIEW_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function isPermissionPreviewActive() {
    return !!getPermissionPreview();
}

// Called from the Workgroups screen's "Preview" button. Stores which
// workgroup to pretend to be and reloads into the app so every page picks
// it up. `startPath` defaults to the dashboard, matching "start the preview
// somewhere everyone can see."
function startPermissionPreview(workgroupId, workgroupName, startPath) {
    try {
        sessionStorage.setItem(PERMISSION_PREVIEW_KEY, JSON.stringify({ id: workgroupId, name: workgroupName }));
    } catch (error) {
        console.error("Failed to start permission preview:", error);
        return;
    }
    window.location.href = startPath || "/pages/dashboard.html";
}

function exitPermissionPreview() {
    try { sessionStorage.removeItem(PERMISSION_PREVIEW_KEY); } catch { /* ignore */ }
    window.location.reload();
}

async function loadPermissionsCatalog() {
    if (permissionsCatalogCache) return permissionsCatalogCache;
    const { data, error } = await window.supabaseClient.from("permissions").select("*").order("sort_order", { ascending: true });
    if (error) throw error;
    permissionsCatalogCache = data || [];
    return permissionsCatalogCache;
}

async function loadWorkgroupPermissionsMap() {
    if (workgroupPermissionsCache) return workgroupPermissionsCache;

    const [{ data: groups, error: groupsError }, { data: rows, error: rowsError }] = await Promise.all([
        window.supabaseClient.from("workgroups").select("id, name"),
        window.supabaseClient.from("workgroup_permissions").select("workgroup_id, permission_key"),
    ]);
    if (groupsError || rowsError) throw (groupsError || rowsError);

    const idToName = new Map((groups || []).map(g => [g.id, String(g.name || "").trim().toLowerCase()]));
    const map = new Map(); // lowercase workgroup name -> Set<permission_key>

    (rows || []).forEach(row => {
        const name = idToName.get(row.workgroup_id);
        if (!name) return;
        if (!map.has(name)) map.set(name, new Set());
        map.get(name).add(row.permission_key);
    });

    workgroupPermissionsCache = map;
    return map;
}

// Call once, early (nav-access.js does this). Safe to call more than once --
// subsequent calls are no-ops once loaded, or once a failure has been seen
// (so a missing migration doesn't retry-loop on every permission check).
//
// 2026-10-14: every caller now waits on the SAME load. Before, a second
// caller arriving while the first load was still in flight returned as soon
// as the permission catalog came back -- before the workgroup grants had --
// and hasPermission() fails open while those are missing, so it briefly
// answered "yes" for everyone (seen as the Bid Invites tab flashing on for
// workgroups without it).
let permissionsInitPromise = null;

function initPermissions() {
    if ((permissionsCatalogCache && workgroupPermissionsCache) || permissionsLoadFailed) return Promise.resolve();
    if (!window.supabaseClient) return Promise.resolve();
    if (!permissionsInitPromise) {
        permissionsInitPromise = (async () => {
            try {
                await Promise.all([loadPermissionsCatalog(), loadWorkgroupPermissionsMap()]);
            } catch (error) {
                console.warn("permissions.js: permissions/workgroup_permissions not available yet, every check will fail open until the migration runs.", error);
                permissionsLoadFailed = true;
            }
        })();
    }
    return permissionsInitPromise;
}

// The core check. Synchronous -- call initPermissions() and await it once on
// page load first (nav-access.js already does), then this reads from cache.
function hasPermission(permissionKey, profileOverride) {
    // Fails open: migration not run yet, or hasn't finished loading.
    if (permissionsLoadFailed || !workgroupPermissionsCache) return true;

    const preview = getPermissionPreview();
    if (preview && !profileOverride) {
        const set = workgroupPermissionsCache.get(String(preview.name || "").trim().toLowerCase());
        return !!(set && set.has(permissionKey));
    }

    const profile = profileOverride || permGetProfile();

    if (isSuperAdminProfile(profile)) return true;

    if (isManagerRoleProfile(profile) && MANAGER_ROLE_BONUS_PERMISSIONS.includes(permissionKey)) return true;

    const groups = window.getSupabaseUserGroups ? window.getSupabaseUserGroups(profile) : [];
    return groups.some(g => {
        const set = workgroupPermissionsCache.get(g);
        return !!(set && set.has(permissionKey));
    });
}

// For the Workgroups screen / right-click editor: every workgroup this
// permission is currently granted to, as a Set of lowercase names. Reads
// straight from cache -- call initPermissions() first.
function workgroupsWithPermission(permissionKey) {
    const names = new Set();
    if (!workgroupPermissionsCache) return names;
    workgroupPermissionsCache.forEach((set, name) => { if (set.has(permissionKey)) names.add(name); });
    return names;
}

function getPermissionsCatalog() {
    return permissionsCatalogCache || [];
}

// Every permission belonging to one page_label, in catalog order -- what a
// right-click-the-tab popup shows for that page.
function permissionsForPage(pageLabel) {
    return getPermissionsCatalog().filter(p => p.page_label === pageLabel);
}

async function grantPermission(workgroupId, permissionKey) {
    const { error } = await window.supabaseClient
        .from("workgroup_permissions")
        .upsert({ workgroup_id: workgroupId, permission_key: permissionKey }, { onConflict: "workgroup_id,permission_key", ignoreDuplicates: true });
    if (error) throw error;
}

async function revokePermission(workgroupId, permissionKey) {
    const { error } = await window.supabaseClient
        .from("workgroup_permissions")
        .delete()
        .eq("workgroup_id", workgroupId)
        .eq("permission_key", permissionKey);
    if (error) throw error;
}

// Applies a grant/revoke to the in-memory cache immediately (call this right
// after a successful grantPermission/revokePermission so open UI reflects it
// without a full reload).
function applyPermissionChangeToCache(workgroupName, permissionKey, granted) {
    if (!workgroupPermissionsCache) return;
    const key = String(workgroupName || "").trim().toLowerCase();
    if (!workgroupPermissionsCache.has(key)) workgroupPermissionsCache.set(key, new Set());
    const set = workgroupPermissionsCache.get(key);
    if (granted) set.add(permissionKey); else set.delete(permissionKey);
}

window.Permissions = {
    initPermissions,
    hasPermission,
    workgroupsWithPermission,
    getPermissionsCatalog,
    permissionsForPage,
    grantPermission,
    revokePermission,
    applyPermissionChangeToCache,
    startPermissionPreview,
    exitPermissionPreview,
    isPermissionPreviewActive,
    getPermissionPreview,
};
