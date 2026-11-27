/* ===========================================================
   HELP BUDDIES (help center + guides) — 2026-11-26

   Theo, our little hard-hat helper (in a few colors), and the soft
   background color blobs for the help pages. Put
   <span class="hc-buddy" data-buddy="search"></span>
   where you want one; this swaps in the drawing. Hover him and he says
   "Hi, I'm Theo!" (change it with data-say="...").

     search     blue, holding a magnifying glass (help center top)
     clipboard  teal, holding a clipboard (guide headers)
     cone       orange, next to a traffic cone ("On the way")
     shrug      purple, arms up (no search results)
     wave       green, waving

   Also adds the background blobs (.hc-blobs) once per page.
   Motion is off for people who ask for reduced motion (see CSS).
=========================================================== */
(function () {
    "use strict";

    const COLORS = {
        search: ["#3d8fd1", "#2a72b0"],
        clipboard: ["#20a090", "#14806f"],
        cone: ["#e98a3a", "#c96d22"],
        shrug: ["#8b6fd6", "#6a4bb5"],
        wave: ["#4fa257", "#2f7d32"],
    };

    let uid = 0;

    function body(kind) {
        const [light, dark] = COLORS[kind] || COLORS.search;
        const id = `hcb${++uid}`;
        return `
            <defs>
                <radialGradient id="${id}" cx="38%" cy="32%" r="75%">
                    <stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/>
                </radialGradient>
            </defs>
            <ellipse cx="70" cy="132" rx="34" ry="5" fill="#0b2236" opacity=".08" class="hcb-shadow"/>
            <g class="hcb-bob">
                <circle cx="70" cy="80" r="44" fill="url(#${id})"/>
                <ellipse cx="54" cy="58" rx="12" ry="7" fill="#fff" opacity=".18"/>
                <path d="M31 63 A39 34 0 0 1 109 63 Z" fill="#f5b83d"/>
                <rect x="64" y="30" width="12" height="33" rx="6" fill="#ffd56e"/>
                <rect x="22" y="59" width="96" height="10" rx="5" fill="#e09a1f"/>
                <g class="hcb-eyes">
                    <ellipse cx="56" cy="86" rx="5.5" ry="7" fill="#0b2236"/>
                    <ellipse cx="84" cy="86" rx="5.5" ry="7" fill="#0b2236"/>
                    <circle cx="58" cy="83" r="2" fill="#fff"/><circle cx="86" cy="83" r="2" fill="#fff"/>
                </g>
                <circle cx="45" cy="98" r="5" fill="#ff9aa8" opacity=".55"/>
                <circle cx="95" cy="98" r="5" fill="#ff9aa8" opacity=".55"/>
                ${kind === "shrug"
                    ? `<path d="M63 103 q7 -4 14 0" stroke="#0b2236" stroke-width="3" fill="none" stroke-linecap="round"/>`
                    : `<path d="M61 100 q9 8 18 0" stroke="#0b2236" stroke-width="3" fill="none" stroke-linecap="round"/>`}
                ${props(kind, dark)}
            </g>`;
    }

    function props(kind, dark) {
        const arm = (d) => `<path d="${d}" stroke="${dark}" stroke-width="8" fill="none" stroke-linecap="round"/>`;
        if (kind === "search") {
            return arm("M30 96 q-8 6 -6 14") + arm("M110 94 q10 -2 14 -12")
                + `<g class="hcb-prop"><line x1="124" y1="80" x2="132" y2="70" stroke="#0b2236" stroke-width="5" stroke-linecap="round"/>
                   <circle cx="138" cy="60" r="13" fill="#e8f4ff" stroke="#0b2236" stroke-width="4"/>
                   <path d="M132 55 a7 7 0 0 1 7 -3" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></g>`;
        }
        if (kind === "clipboard") {
            return arm("M110 96 q8 6 6 14")
                + `<g class="hcb-prop"><rect x="8" y="80" width="30" height="38" rx="4" fill="#fff" stroke="#0b2236" stroke-width="3"/>
                   <rect x="16" y="76" width="14" height="8" rx="2" fill="#0b2236"/>
                   <path d="M15 94 h16 M15 102 h16 M15 110 h10" stroke="#9fb3c4" stroke-width="3" stroke-linecap="round"/></g>`
                + arm("M30 94 q-4 4 0 8");
        }
        if (kind === "cone") {
            return arm("M30 96 q-8 6 -6 14") + arm("M110 96 q8 6 6 14")
                + `<g class="hcb-prop"><path d="M136 132 l10 -44 h6 l10 44 z" fill="#f07b2a"/>
                   <path d="M141 112 h16 l2 8 h-20 z M144 98 h10 l1.5 6 h-13 z" fill="#fff"/>
                   <rect x="130" y="128" width="38" height="6" rx="3" fill="#c75d16"/></g>`;
        }
        if (kind === "shrug") {
            return arm("M30 90 q-12 -4 -14 -18") + arm("M110 90 q12 -4 14 -18");
        }
        if (kind === "wave") {
            return arm("M30 96 q-8 6 -6 14") + `<g class="hcb-wave">${arm("M110 90 q14 -6 16 -24")}</g>`;
        }
        return "";
    }

    function draw(el) {
        if (el.dataset.drawn) return;
        el.dataset.drawn = "1";
        const kind = el.dataset.buddy || "search";
        const wide = kind === "cone" || kind === "search";
        const say = el.dataset.say || "Hi, I'm Theo!";
        el.innerHTML = `<span class="hc-say" role="tooltip">${say.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))}</span>`
            + `<svg viewBox="0 0 ${wide ? 170 : 150} 140" aria-hidden="true" focusable="false">${body(kind)}</svg>`;
        el.setAttribute("aria-label", "Theo");
    }

    function blobs() {
        if (document.querySelector(".hc-blobs")) return;
        const b = document.createElement("div");
        b.className = "hc-blobs";
        b.setAttribute("aria-hidden", "true");
        b.innerHTML = "<span></span><span></span><span></span><span></span>";
        document.body.prepend(b);
    }

    window.HelpBuddies = { draw, refresh: () => document.querySelectorAll(".hc-buddy[data-buddy]").forEach(draw) };

    function init() { blobs(); window.HelpBuddies.refresh(); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
