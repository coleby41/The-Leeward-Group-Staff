/* ===========================================================
   PROJECT OVERVIEW (pages/projects.html) — rebuilt 2026-11-16

   Layout (matches the "Project Overview" design board):
     1. Title row — name + status chip, code · address, Edit, Open timeline
     2. Four number tiles — Schedule · Spent · Open tasks · Latest draw
        (falls back to Bids out until the Draws feature exists)
     3. Timeline strip — phases on a month axis with a Today line
     4. Left: Needs attention + Coming up
        Right: Money, Latest photos, Recent activity (expands in place)

   Every number comes from js/project-metrics.js — nothing is hand-typed.
   Waits for project-shell.js's "project-shell:ready" event.
=========================================================== */
(function () {
    "use strict";

    const $ = id => document.getElementById(id);

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function money(n, opts) {
        const v = Number(n) || 0;
        if (opts && opts.short) {
            if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
            if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
        }
        return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    }

    function shortDate(iso, withYear) {
        if (!iso) return "—";
        const d = new Date(iso.slice(0, 10) + "T00:00:00");
        if (Number.isNaN(d.getTime())) return "—";
        return d.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
    }

    function ago(iso) {
        const ms = Date.now() - new Date(iso).getTime();
        const h = Math.round(ms / 3600000);
        if (h < 1) return "just now";
        if (h < 24) return `${h}h ago`;
        const d = Math.round(h / 24);
        if (d === 1) return "yesterday";
        if (d < 7) return `${d} days ago`;
        return shortDate(iso);
    }

    function bar(percent, extraClass) {
        const p = Math.max(0, Math.min(100, Number(percent) || 0));
        return `<div class="pov-bar ${extraClass || ""}"><span style="width:${p}%"></span></div>`;
    }

    /* ---------- 1. title row ---------- */

    function renderTitle(project) {
        const PF = window.ProjectFields || {};
        const meta = (PF.PROJECT_STATUSES || []).find(s => s.value === (project.status || "onboarding"));
        const address = [project.site_address, [project.site_city, project.site_state].filter(Boolean).join(", ")].filter(Boolean).join(", ");
        const bits = [project.project_code, address].filter(Boolean).map(esc).join(" · ");

        $("povTitle").innerHTML = `
            <div class="pov-title-main">
                <div class="pov-title-name">
                    <h1>${esc(project.name || "Untitled project")}</h1>
                    <span class="chip chip--dot ${meta ? meta.chip : "chip--info"}">${esc(meta ? meta.label : "Onboarding")}</span>
                </div>
                <p class="pov-title-meta">${bits || "No site address on file"}</p>
            </div>
            <div class="pov-title-actions">
                <a class="pov-link-muted" href="/pages/project-home.html?openWizard=${encodeURIComponent(project.id)}">Edit</a>
                <a class="auth-button pov-btn" href="/pages/project-timeline.html">Open timeline</a>
            </div>`;
    }

    /* ---------- 2. number tiles ---------- */

    function scheduleTile(s) {
        let status;
        if (!s.hasTasks) status = `<p class="pov-tile-sub">Add tasks on the Timeline</p>`;
        else if (!s.hasPlan) status = `<p class="pov-tile-sub">Lock the plan on the Timeline to track days behind</p>`;
        else if (s.daysBehind > 0) status = `<p class="pov-tile-sub pov-warn">${s.daysBehind} day${s.daysBehind === 1 ? "" : "s"} behind · finish ${shortDate(s.finishDate)}</p>`;
        else if (s.daysBehind < 0) status = `<p class="pov-tile-sub pov-good">${-s.daysBehind} day${s.daysBehind === -1 ? "" : "s"} ahead · finish ${shortDate(s.finishDate)}</p>`;
        else status = `<p class="pov-tile-sub">On plan · finish ${shortDate(s.finishDate)}</p>`;
        return `
            <div class="pov-tile">
                <p class="pov-tile-label">Schedule</p>
                <p class="pov-tile-value">${s.percentDone}% <span>plan ${s.planPercent}%</span></p>
                ${bar(s.percentDone)}
                ${status}
            </div>`;
    }

    function spentTile(m) {
        if (!m.contract && !m.invoiceCount) {
            return `<div class="pov-tile"><p class="pov-tile-label">Spent</p><p class="pov-tile-value">$0</p><p class="pov-tile-sub">No invoices yet</p></div>`;
        }
        return `
            <div class="pov-tile">
                <p class="pov-tile-label">Spent</p>
                <p class="pov-tile-value">${money(m.spent, { short: true })}</p>
                ${m.contract ? bar(m.spentPercent) : ""}
                <p class="pov-tile-sub">${m.contract ? `${m.spentPercent}% of ${money(m.contract, { short: true })} contract` : `${m.invoiceCount} invoice${m.invoiceCount === 1 ? "" : "s"} · no contract value`}</p>
            </div>`;
    }

    function tasksTile(s) {
        const n = s.overdue.length;
        return `
            <div class="pov-tile">
                <p class="pov-tile-label">Open tasks</p>
                <p class="pov-tile-value">${s.openCount}</p>
                <p class="pov-tile-sub ${n ? "pov-bad" : ""}">${n ? `${n} overdue` : `${s.doneCount} done`}</p>
            </div>`;
    }

    function fourthTile(data) {
        const d = data.latestDraw;
        if (d) {
            const label = { draft: "Draft", submitted: "Submitted", funded: "Funded" }[d.status] || d.status;
            return `
                <a class="pov-tile pov-tile--link" href="/pages/project-accounting.html#draws">
                    <p class="pov-tile-label">Draw #${esc(d.draw_number)}</p>
                    <p class="pov-tile-value" id="povDrawAmount">${esc(label)}</p>
                    <p class="pov-tile-sub">${esc(label)} · period to ${shortDate(d.period_to)}</p>
                </a>`;
        }
        const b = data.bids;
        return `
            <a class="pov-tile pov-tile--link" href="/pages/project-bids.html">
                <p class="pov-tile-label">Bids out</p>
                <p class="pov-tile-value">${b.open.length} <span>package${b.open.length === 1 ? "" : "s"}</span></p>
                <p class="pov-tile-sub">${b.open.length ? `${b.replied} of ${b.invited} replied${b.nextDue ? " · due " + shortDate(b.nextDue) : ""}` : "None open"}</p>
            </a>`;
    }

    /* ---------- 3. timeline strip ---------- */

    function renderTimeline(data) {
        const el = $("povTimeline");
        const phases = data.phases.filter(p => p.start && p.end);
        if (!phases.length) {
            el.innerHTML = `<p class="pov-empty">No tasks on the Project Timeline yet.</p>`;
            return;
        }
        const M = window.ProjectMetrics;
        const start = phases.map(p => p.start).sort()[0];
        const end = phases.map(p => p.end).sort().slice(-1)[0];
        const s0 = M.dayNum(start), span = Math.max(1, M.dayNum(end) - s0 + 1);
        const pct = iso => ((M.dayNum(iso) - s0) / span) * 100;
        const todayPct = Math.max(0, Math.min(100, pct(M.todayISO())));

        // Month labels across the span
        const months = [];
        const cur = new Date(start + "T00:00:00Z"); cur.setUTCDate(1);
        while (cur.toISOString().slice(0, 10) <= end && months.length < 24) {
            months.push(cur.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }));
            cur.setUTCMonth(cur.getUTCMonth() + 1);
        }

        const meta = p => (p.total && p.complete === p.total ? "Done" : p.percent ? `${p.complete} of ${p.total}` : "Not started");
        el.innerHTML = `
            <div class="pov-tl">
                <div></div>
                <div class="pov-tl-months">${months.map(m => `<span>${m}</span>`).join("")}</div>
                ${phases.map(p => `
                    <div class="pov-tl-name"><span>${esc(p.name)}</span><small>${meta(p)}</small></div>
                    <div class="pov-tl-track">
                        <div class="pov-tl-bar" style="left:${pct(p.start)}%;width:${Math.max(1.5, pct(p.end) + 100 / span - pct(p.start))}%"><span style="width:${p.percent}%"></span></div>
                        <div class="pov-tl-today" style="left:${todayPct}%"></div>
                    </div>
                    <div class="pov-tl-phone">${bar(p.percent)}</div>`).join("")}
                <div></div>
                <div class="pov-tl-track pov-tl-track--label"><span class="pov-tl-today-label" style="left:${todayPct}%">Today</span></div>
            </div>`;
    }

    /* ---------- 4. lists ---------- */

    function renderAttention(items) {
        const el = $("povAttention");
        if (!items.length) {
            el.innerHTML = `<p class="pov-empty">Nothing needs attention right now.</p>`;
            return;
        }
        el.innerHTML = items.map(a => `
            <a class="pov-row" href="${a.href}">
                <span class="pov-dot pov-dot--${a.level}"></span>
                <span class="pov-row-text"><strong>${esc(a.title)}</strong><small>${esc(a.meta)}</small></span>
                <span class="pov-chev" aria-hidden="true">›</span>
            </a>`).join("");
    }

    function renderUpcoming(items) {
        const el = $("povUpcoming");
        if (!items.length) {
            el.innerHTML = `<p class="pov-empty">Nothing in the next 14 days.</p>`;
            return;
        }
        el.innerHTML = items.map(u => {
            const d = new Date(u.date + "T00:00:00");
            return `
                <div class="pov-row pov-row--static">
                    <span class="pov-date"><small>${d.toLocaleDateString("en-US", { month: "short" })}</small>${d.getDate()}</span>
                    <span class="pov-row-text"><span>${esc(u.name)}</span></span>
                    <span class="pov-note ${u.kind === "late" ? "pov-bad" : ""}">${esc(u.note)}</span>
                </div>`;
        }).join("");
    }

    function renderMoney(m) {
        const el = $("povMoney");
        if (!m.contract && !m.invoiceCount) {
            el.innerHTML = `<p class="pov-empty">No contract value or invoices yet.</p>`;
            return;
        }
        const base = Math.max(m.contract, m.spent) || 1;
        el.innerHTML = `
            <div class="pov-stack">
                <span class="pov-stack-paid" style="width:${(m.paid / base) * 100}%"></span>
                <span class="pov-stack-unpaid" style="width:${(m.unpaid / base) * 100}%"></span>
            </div>
            <div class="pov-money-rows">
                <div><span><i class="pov-key pov-key--paid"></i>Paid</span><strong>${money(m.paid)}</strong></div>
                <div><span><i class="pov-key pov-key--unpaid"></i>Unpaid</span><strong>${money(m.unpaid)}</strong></div>
                ${m.contract ? `<div><span><i class="pov-key"></i>Left on contract</span><strong>${money(m.left)}</strong></div>` : ""}
            </div>
            ${m.contract ? `<p class="pov-small">Contract ${money(m.contract, { short: true })}${m.vpoCount ? ` = ${money(m.original, { short: true })} original + ${m.vpoCount} VPO${m.vpoCount === 1 ? "" : "s"}` : ""}</p>` : ""}`;
    }

    async function renderPhotos(photos) {
        const el = $("povPhotos");
        if (!photos.length) {
            el.innerHTML = `<p class="pov-empty">No photos yet.</p>`;
            return;
        }
        el.innerHTML = photos.map((p, i) => `<button type="button" class="pov-photo" data-i="${i}" aria-label="Open ${esc(p.file_name)}"></button>`).join("");
        // Signed URLs for the thumbnails (private bucket)
        await Promise.all(photos.map(async (p, i) => {
            try {
                const { data } = await window.supabaseClient.storage.from(p.bucket || "project-documents").createSignedUrl(p.storage_path, 60 * 60);
                if (!data || !data.signedUrl) return;
                p._url = data.signedUrl;
                const btn = el.querySelector(`[data-i="${i}"]`);
                if (btn) btn.style.backgroundImage = `url('${data.signedUrl.replace(/'/g, "%27")}')`;
            } catch (e) { /* thumbnail stays blank */ }
        }));
        el.querySelectorAll(".pov-photo").forEach(btn => btn.addEventListener("click", () => {
            const p = photos[Number(btn.dataset.i)];
            if (p && p._url && window.FilePreview) window.FilePreview.open({ name: p.file_name, url: p._url, kind: "image" });
        }));
    }

    function renderActivity(rows) {
        const el = $("povActivityList");
        el.innerHTML = rows.length
            ? rows.map(r => `<div class="pov-activity-row"><p>${esc(r.text)}</p><small>${esc([r.who, ago(r.at)].filter(Boolean).join(" · "))}</small></div>`).join("")
            : `<p class="pov-empty">No activity yet.</p>`;
    }

    /* ---------- bootstrap ---------- */

    async function render(project) {
        if (!project) {
            $("povTitle").innerHTML = `<p class="pov-empty">No project selected. Pick one from Project Overview.</p>`;
            $("povBody").style.display = "none";
            return;
        }
        renderTitle(project);
        let data;
        try {
            data = await window.ProjectMetrics.loadOverview(project);
        } catch (e) {
            console.error("Overview load failed:", e);
            $("povTiles").innerHTML = `<p class="pov-empty">Couldn't load this project's numbers.</p>`;
            return;
        }
        $("povTiles").innerHTML = scheduleTile(data.schedule) + spentTile(data.money) + tasksTile(data.schedule) + fourthTile(data);
        renderTimeline(data);
        renderAttention(data.attention);
        renderUpcoming(data.upcoming);
        renderMoney(data.money);
        renderActivity(data.activity);
        renderPhotos(data.photos);
        if (data.latestDraw) fillDrawAmount(project, data.latestDraw);
    }

    // The draw tile's amount needs the full draw math (js/draws-core.js).
    async function fillDrawAmount(project, draw) {
        if (!window.Draws) return;
        try {
            const st = await window.Draws.load(project.id);
            const el = $("povDrawAmount");
            if (el && st.draws.some(d => d.id === draw.id)) el.textContent = money(window.Draws.sheet(st, draw.id).summary.currentPaymentDue, { short: true });
        } catch (e) { /* no draws access — tile keeps the status */ }
    }

    window.ProjectOverview = { render };
})();
