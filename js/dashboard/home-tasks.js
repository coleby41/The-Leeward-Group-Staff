/* ============================================================================
   home-tasks.js — "My tasks" on the Home page (2026-11-18).
   Replaces dashboard/task.js on pages/dashboard.html (task.js is left as is).

   One list for both kinds of work, each with a tag:
     - Personal  → public.tasks (user_id = me)
     - <Project> → public.project_todo_subitems (assigned_to = me)
   Sorted by due date (late first, no date last). Ticking the box marks it
   done in whichever table it came from. The "Add a task…" line still adds a
   personal task. The counts in the glass bar are updated from here too.
============================================================================ */
(function () {
  "use strict";
  const DS = window.DashboardShared;
  const MAX_ROWS = 8;
  let staffId = null;

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const listEl = document.getElementById("myTasksList");
    const addInput = document.getElementById("newTaskInlineInput");
    const dueInput = document.getElementById("newTaskDueDateInput");
    if (!listEl || !DS) return;

    const profile = await DS.getStaffProfile();
    staffId = DS.getUserId(profile);
    if (!staffId) {
      listEl.innerHTML = '<p class="card-subtitle">Sign in to see your tasks.</p>';
      if (addInput) addInput.disabled = true;
      return;
    }
    await load();

    if (addInput) addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addPersonal(addInput, dueInput); }
    });
    wireNewTask(addInput);
  });

  /* ---- "+ New task": phones get a bottom sheet, desktop jumps to the inline line ---- */
  const phone = window.matchMedia("(max-width: 768px)");

  function isoOffset(days) {
    const d = new Date(); d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function wireNewTask(addInput) {
    const btn = document.getElementById("homeNewTaskBtn");
    const overlay = document.getElementById("homeTaskSheet");
    const form = document.getElementById("homeTaskSheetForm");
    const title = document.getElementById("homeTaskSheetTitle");
    const name = document.getElementById("homeTaskSheetName");
    const date = document.getElementById("homeTaskSheetDate");
    const msg = document.getElementById("homeTaskSheetMsg");
    const save = document.getElementById("homeTaskSheetSave");
    const switchBtn = document.getElementById("homeTaskSheetSwitch");
    const projFields = document.getElementById("homeSheetProjectFields");
    const projSel = document.getElementById("homeSheetProject");
    const listSel = document.getElementById("homeSheetList");
    const newListWrap = document.getElementById("homeSheetNewListWrap");
    const newList = document.getElementById("homeSheetNewList");
    const assignWrap = document.getElementById("homeSheetAssignWrap");
    const assignSel = document.getElementById("homeSheetAssign");
    const chips = overlay ? Array.from(overlay.querySelectorAll(".hm-chip")) : [];
    let mode = "personal";
    let staff = [];
    let lookupsLoaded = false;

    const esc = (v) => DS.escapeHtml(v);
    function setMsg(text, type) { msg.textContent = text || ""; msg.className = `auth-message${type ? " " + type : ""}`; }
    function pickChip(value) { chips.forEach(c => c.classList.toggle("is-on", c.dataset.due === value)); }

    function setMode(next) {
      mode = next;
      const project = mode === "project";
      projFields.hidden = !project;
      assignWrap.hidden = !project;
      title.textContent = project ? "New project to-do" : "New task";
      save.textContent = project ? "Add to-do" : "Add task";
      switchBtn.textContent = project ? "Add a personal task instead" : "Add a project to-do";
      name.placeholder = project ? "e.g. Order window flashing" : "e.g. Call the inspector";
      setMsg("");
      if (project) loadLookups();
    }

    async function loadLookups() {
      if (lookupsLoaded) return;
      lookupsLoaded = true;
      const sb = window.supabaseClient;
      const [{ data: projects }, { data: people }] = await Promise.all([
        DS.safeQuery("sheet projects", sb.from("projects").select("id, name, status").in("status", ["active", "onboarding", "on_hold"]).order("name")),
        DS.safeQuery("sheet staff", sb.from("staff_users_directory").select("id, full_name, active").eq("active", true).order("full_name"))
      ]);
      projSel.innerHTML = '<option value="">Choose a project</option>' +
        (projects || []).map(p => `<option value="${esc(p.id)}">${esc(p.name || "Untitled project")}</option>`).join("");
      staff = people || [];
      assignSel.innerHTML = '<option value="">Unassigned</option>' +
        staff.map(p => `<option value="${esc(p.id)}"${String(p.id) === String(staffId) ? " selected" : ""}>${esc(p.full_name || "Staff")}${String(p.id) === String(staffId) ? " (me)" : ""}</option>`).join("");
    }

    async function loadLists(projectId) {
      newListWrap.hidden = true;
      if (!projectId) { listSel.innerHTML = '<option value="">Pick a project first</option>'; listSel.disabled = true; return; }
      listSel.disabled = true;
      listSel.innerHTML = '<option value="">Loading…</option>';
      const { data } = await DS.safeQuery("sheet lists", window.supabaseClient.from("project_todo_items")
        .select("id, title, completed, position").eq("project_id", projectId).order("position"));
      const open = (data || []).filter(i => !i.completed);
      listSel.innerHTML = open.map(i => `<option value="${esc(i.id)}">${esc(i.title)}</option>`).join("") +
        '<option value="__new">+ New list…</option>';
      listSel.disabled = false;
      if (!open.length) { listSel.value = "__new"; newListWrap.hidden = false; }
    }

    function openSheet(startMode) {
      if (!overlay) return;
      form.reset(); pickChip(""); setMode(startMode || "personal");
      newListWrap.hidden = true;
      overlay.classList.remove("hidden");
      document.body.classList.add("popup-active");
      setTimeout(() => name.focus(), 60);
    }
    function closeSheet() {
      overlay.classList.add("hidden");
      if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
    }

    if (btn) btn.addEventListener("click", () => {
      if (phone.matches) { openSheet("personal"); return; }
      if (addInput) { addInput.scrollIntoView({ behavior: "smooth", block: "center" }); addInput.focus(); }
    });
    // On a phone, tapping the inline "Add a task…" line opens the sheet instead of the tiny field.
    if (addInput) addInput.addEventListener("focus", () => {
      if (!phone.matches) return;
      addInput.blur();
      openSheet("personal");
    });
    if (!overlay) return;

    switchBtn.addEventListener("click", () => setMode(mode === "project" ? "personal" : "project"));
    projSel.addEventListener("change", () => loadLists(projSel.value));
    listSel.addEventListener("change", () => {
      newListWrap.hidden = listSel.value !== "__new";
      if (!newListWrap.hidden) newList.focus();
    });
    chips.forEach(c => c.addEventListener("click", () => {
      const v = c.dataset.due;
      date.value = v === "today" ? isoOffset(0) : v === "tomorrow" ? isoOffset(1) : v === "week" ? isoOffset(7) : "";
      pickChip(v);
    }));
    date.addEventListener("change", () => pickChip(date.value ? "custom" : ""));
    document.getElementById("homeTaskSheetCancel").addEventListener("click", closeSheet);
    document.getElementById("homeTaskSheetClose").addEventListener("click", closeSheet);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSheet(); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const label = name.value.trim();
      if (mode === "project" && !projSel.value) { setMsg("Choose a project first.", "error"); projSel.focus(); return; }
      if (mode === "project" && listSel.value === "__new" && !newList.value.trim()) { setMsg("Name the new list.", "error"); newList.focus(); return; }
      if (!label) { setMsg("Type what needs doing first.", "error"); name.focus(); return; }
      save.disabled = true;
      setMsg("Saving…");
      const ok = mode === "project" ? await saveProjectTodo(label) : await savePersonal(label);
      save.disabled = false;
      if (!ok) return;
      closeSheet();
      load();
      if (typeof window.showToast === "function") window.showToast(mode === "project" ? "Project to-do added" : "Task added");
    });

    async function savePersonal(label) {
      const { error } = await DS.safeQuery("create task", window.supabaseClient.from("tasks").insert({
        user_id: staffId, task_name: label, due_date: date.value || null, description: null, completed: false
      }));
      if (error) { setMsg("Couldn't add that task. Please try again.", "error"); return false; }
      return true;
    }

    // Same rows the project To-do page writes (js/project-todo.js addSubitem / new big item).
    async function saveProjectTodo(label) {
      const sb = window.supabaseClient;
      const projectId = projSel.value;
      const projectName = projSel.options[projSel.selectedIndex]?.text || "a project";
      const profile = window.currentSupabaseProfile || {};
      let listId = listSel.value;

      if (listId === "__new") {
        const { data: lists } = await DS.safeQuery("sheet list count", sb.from("project_todo_items").select("id").eq("project_id", projectId));
        const { data: created, error } = await DS.safeQuery("create list", sb.from("project_todo_items").insert({
          project_id: projectId, title: newList.value.trim(), position: (lists || []).length,
          created_by_id: staffId, created_by_name: profile.full_name || null
        }).select().single());
        if (error || !created) { setMsg("Couldn't create the new list. Please try again.", "error"); return false; }
        listId = created.id;
      }

      const { data: existing } = await DS.safeQuery("sheet item count", sb.from("project_todo_subitems").select("id").eq("todo_item_id", listId));
      const assigneeId = assignSel.value || null;
      const assigneeName = assigneeId ? (staff.find(p => String(p.id) === String(assigneeId)) || {}).full_name || null : null;
      const { error } = await DS.safeQuery("create project to-do", sb.from("project_todo_subitems").insert({
        todo_item_id: listId, project_id: projectId, label,
        assigned_to: assigneeId, assigned_to_name: assigneeName,
        due_date: date.value || null, position: (existing || []).length
      }));
      if (error) { setMsg("Couldn't add that to-do. Please try again.", "error"); return false; }

      // Let someone else know it's theirs (same notice the To-do page sends).
      if (assigneeId && String(assigneeId) !== String(staffId)) {
        DS.safeQuery("notify assignee", sb.from("notifications").insert({
          user_id: assigneeId, title: "New project to-do",
          message: `You were assigned "${label}" on ${projectName}.`,
          type: "project_todo_assignment",
          link_url: `/pages/project-todo.html?id=${encodeURIComponent(projectId)}`, link_label: "View it here"
        }));
      }
      return true;
    }
  }
})();
