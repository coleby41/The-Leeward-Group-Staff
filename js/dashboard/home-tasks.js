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
    const name = document.getElementById("homeTaskSheetName");
    const date = document.getElementById("homeTaskSheetDate");
    const msg = document.getElementById("homeTaskSheetMsg");
    const save = document.getElementById("homeTaskSheetSave");
    const chips = overlay ? Array.from(overlay.querySelectorAll(".hm-chip")) : [];

    function pickChip(value) {
      chips.forEach(c => c.classList.toggle("is-on", c.dataset.due === value));
    }
    function openSheet() {
      if (!overlay) return;
      form.reset(); msg.textContent = ""; msg.className = "auth-message"; pickChip("");
      overlay.classList.remove("hidden");
      document.body.classList.add("popup-active");
      setTimeout(() => name.focus(), 60);
    }
    function closeSheet() {
      overlay.classList.add("hidden");
      if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
    }

    if (btn) btn.addEventListener("click", () => {
      if (phone.matches) { openSheet(); return; }
      if (addInput) { addInput.scrollIntoView({ behavior: "smooth", block: "center" }); addInput.focus(); }
    });
    // On a phone, tapping the inline "Add a task…" line opens the sheet instead of the tiny field.
    if (addInput) addInput.addEventListener("focus", () => {
      if (!phone.matches) return;
      addInput.blur();
      openSheet();
    });
    if (!overlay) return;

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
      const task = name.value.trim();
      if (!task) { msg.textContent = "Type what needs doing first."; msg.className = "auth-message error"; name.focus(); return; }
      save.disabled = true;
      const { error } = await DS.safeQuery("create task", window.supabaseClient.from("tasks").insert({
        user_id: staffId, task_name: task, due_date: date.value || null, description: null, completed: false
      }));
      save.disabled = false;
      if (error) { msg.textContent = "Couldn't add that task. Please try again."; msg.className = "auth-message error"; return; }
      closeSheet();
      load();
    });
  }

  async function load() {
    const sb = window.supabaseClient;
    const listEl = document.getElementById("myTasksList");
    const [mine, project] = await Promise.all([
      DS.safeQuery("load tasks", sb.from("tasks").select("id, task_name, due_date").eq("user_id", staffId).eq("completed", false)),
      DS.safeQuery("load assigned to-dos", sb.from("project_todo_subitems").select("id, label, due_date, project_id, projects(name)").eq("assigned_to", staffId).eq("completed", false))
    ]);
    if (mine.error && project.error) {
      listEl.innerHTML = '<p class="card-subtitle">Couldn\'t load tasks right now.</p>';
      return;
    }

    const rows = [
      ...(mine.data || []).map(t => ({ kind: "personal", id: t.id, title: t.task_name, due: t.due_date, tag: "Personal" })),
      ...(project.data || []).map(s => ({ kind: "project", id: s.id, title: s.label, due: s.due_date, tag: (s.projects && s.projects.name) || "Project", projectId: s.project_id }))
    ].sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || String(a.due || "").localeCompare(String(b.due || "")) || a.title.localeCompare(b.title));

    updateStrip(rows);
    render(rows);
  }

  function updateStrip(rows) {
    const today = todayISO();
    const dueNow = rows.filter(r => r.due && r.due <= today).length;
    const count = document.getElementById("homeTaskCount");
    const sub = document.getElementById("homeTaskSub");
    if (count) count.textContent = String(rows.length);
    if (sub) {
      sub.textContent = dueNow ? `${dueNow} due today or late` : "Nothing due today";
      sub.className = `hm-stat-sub ${dueNow ? "hm-warn" : ""}`;
    }
  }

  function render(rows) {
    const listEl = document.getElementById("myTasksList");
    if (!rows.length) { listEl.innerHTML = '<p class="card-subtitle">No open tasks — nice work.</p>'; return; }
    const esc = DS.escapeHtml;
    const extra = rows.length - MAX_ROWS;
    listEl.innerHTML = rows.slice(0, MAX_ROWS).map(r => {
      const due = DS.formatDueLabel(r.due);
      const late = due.cls === "due-overdue";
      const soon = due.cls === "due-today";
      const tag = r.kind === "personal"
        ? '<span class="hm-tag">Personal</span>'
        : `<a class="hm-tag hm-tag--blue" href="/pages/project-todo.html?id=${encodeURIComponent(r.projectId)}">${esc(r.tag)}</a>`;
      return `<div class="mytask-row" data-kind="${r.kind}" data-id="${r.id}">
          <input type="checkbox" class="todo-item-checkbox" aria-label="Mark '${esc(r.title)}' done">
          <span class="mytask-row-title">${esc(r.title)}</span>
          ${tag}
          <span class="hm-due ${late ? "hm-due--late" : soon ? "hm-due--today" : ""}">${esc(due.text)}</span>
        </div>`;
    }).join("") + (extra > 0 ? `<a class="hm-more" href="/pages/staff-todo.html">${extra} more ›</a>` : "");

    listEl.querySelectorAll(".mytask-row input[type=checkbox]").forEach(box => {
      box.addEventListener("change", () => complete(box.closest(".mytask-row"), box));
    });
  }

  async function complete(row, box) {
    box.disabled = true;
    const table = row.dataset.kind === "personal" ? "tasks" : "project_todo_subitems";
    const { error } = await DS.safeQuery("complete task", window.supabaseClient.from(table).update({ completed: true }).eq("id", row.dataset.id));
    if (error) { box.checked = false; box.disabled = false; return; }
    row.classList.add("hm-done");
    setTimeout(load, 350);
  }

  async function addPersonal(input, dueInput) {
    const name = input.value.trim();
    if (!name) return;
    input.disabled = true;
    const { error } = await DS.safeQuery("create task", window.supabaseClient.from("tasks").insert({
      user_id: staffId, task_name: name, due_date: (dueInput && dueInput.value) || null, description: null, completed: false
    }));
    input.disabled = false;
    if (error) return;
    input.value = "";
    if (dueInput) dueInput.value = "";
    input.focus();
    load();
  }
})();
