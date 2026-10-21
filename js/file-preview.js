/* ===========================================================
   FILE PREVIEW — every "View" / "Preview" / "Open" of a document opens
   inside the portal, never in a new browser tab (Coleby, 2026-10-21).

   window.FilePreview.open({
       name,                 // shown in the header; also used to guess the type
       url | getUrl(),       // the file (a signed URL or a blob: URL), or an async getter
       getDownloadUrl(),     // optional: a URL that downloads (Content-Disposition: attachment)
       kind,                 // optional: "pdf" | "image" | "other" (otherwise from the name)
   })
   window.FilePreview.download(url, name)   // saves a file without leaving the page

   Same modal markup/classes as Project Files' preview (.popup--preview,
   .file-preview-*) — built once, on first use, so any page can call it.
=========================================================== */
(function () {
    "use strict";

    let overlay = null;
    let current = null;   // the open() call being shown (guards slow URL fetches)

    function esc(value) {
        const d = document.createElement("div");
        d.textContent = value ?? "";
        return d.innerHTML;
    }

    function kindFor(name, url) {
        const s = String(name || url || "").toLowerCase().split("?")[0];
        if (/\.pdf$/.test(s)) return "pdf";
        if (/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/.test(s)) return "image";
        return "other";
    }

    function ensure() {
        if (overlay) return overlay;
        overlay = document.createElement("div");
        overlay.className = "popup-overlay hidden";
        overlay.id = "sharedFilePreviewOverlay";
        overlay.innerHTML = `
            <div class="popup popup--preview" role="dialog" aria-modal="true" aria-labelledby="sharedFilePreviewTitle">
                <div class="file-preview-header">
                    <h2 id="sharedFilePreviewTitle">Preview</h2>
                    <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto">
                        <button type="button" class="workbook-btn workbook-btn--download hidden" id="sharedFilePreviewDownload">Download</button>
                        <button type="button" class="file-preview-close-btn" id="sharedFilePreviewClose" aria-label="Close preview">✕</button>
                    </div>
                </div>
                <div class="file-preview-body" id="sharedFilePreviewBody"></div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
        overlay.querySelector("#sharedFilePreviewClose").addEventListener("click", close);
        overlay.querySelector("#sharedFilePreviewDownload").addEventListener("click", async () => {
            const req = current;
            if (!req) return;
            try {
                const url = req.getDownloadUrl ? await req.getDownloadUrl() : req.resolvedUrl;
                if (url) download(url, req.name);
            } catch (err) {
                console.error("Download failed:", err);
            }
        });
        document.addEventListener("keydown", e => { if (e.key === "Escape" && overlay && !overlay.classList.contains("hidden")) close(); });
        return overlay;
    }

    function close() {
        if (!overlay) return;
        overlay.classList.add("hidden");
        overlay.querySelector("#sharedFilePreviewBody").innerHTML = ""; // stop the iframe loading
        if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
        current = null;
    }

    async function open(opts) {
        const req = { ...opts };
        current = req;
        const el = ensure();
        const body = el.querySelector("#sharedFilePreviewBody");
        el.querySelector("#sharedFilePreviewTitle").textContent = req.name || "Preview";
        el.querySelector("#sharedFilePreviewDownload").classList.toggle("hidden", !(req.getDownloadUrl || req.url || req.getUrl));
        body.innerHTML = `<div class="file-preview-loading">Loading preview…</div>`;
        el.classList.remove("hidden");
        document.body.classList.add("popup-active");

        let url = req.url || null;
        try {
            if (!url && req.getUrl) url = await req.getUrl();
        } catch (err) {
            console.error("Preview link failed:", err);
            url = null;
        }
        if (current !== req) return; // closed, or another file opened meanwhile
        if (!url) {
            body.innerHTML = `<div class="file-preview-error">Couldn't load a preview for this file.</div>`;
            return;
        }
        req.resolvedUrl = url;

        const kind = req.kind || kindFor(req.name, url);
        if (kind === "image") {
            body.innerHTML = `<img class="file-preview-image" alt="${esc(req.name || "")}">`;
            const img = body.querySelector("img");
            img.addEventListener("error", () => {
                if (current === req) unsupported(body, "Your browser can't display this image.");
            }, { once: true });
            img.src = url;
        } else if (kind === "pdf") {
            body.innerHTML = `<iframe class="file-preview-frame" title="${esc(req.name || "Document")}"></iframe>`;
            body.querySelector("iframe").src = url;
        } else {
            unsupported(body, "Preview isn't available for this file type. Use Download instead.");
        }
    }

    function unsupported(body, message) {
        body.innerHTML = `<div class="file-preview-unsupported"><p>${esc(message)}</p></div>`;
    }

    // Saves a file without opening a tab. A signed "download" URL already
    // makes the browser save it; for anything else (a blob, a plain signed
    // URL) the download attribute does it when the file is same-origin.
    function download(url, name) {
        // Supabase signed URLs download (instead of open) with &download=.
        if (/\/storage\/v1\/object\/sign\//.test(url) && !/[?&]download=/.test(url)) {
            url += `${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(name || "")}`;
        }
        const a = document.createElement("a");
        a.href = url;
        if (name) a.download = name;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    window.FilePreview = { open, close, download };
})();
