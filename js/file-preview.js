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
   window.FilePreview.renderPdf(bodyEl, url, name) // PDF into any preview body (swipe pages on phones)

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
        destroyPdf(overlay.querySelector("#sharedFilePreviewBody"));
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
            renderPdf(body, url, req.name);
        } else {
            unsupported(body, "Preview isn't available for this file type. Use Download instead.");
        }
    }

    /* ---------- PDFs on phones: swipe page by page (Coleby, 2026-11-23) ----------
       An <iframe> PDF on iPhone only shows page 1, shrunk, and won't
       scroll. On phones (<= 768px, same cutoff as the phone sheets) each
       page is drawn with pdf.js (same version legacy-forms-import.js uses,
       loaded only the first time it's needed) and laid out side by side:
       swipe left/right, one page at a time, with dots + "2 / 5" underneath.
       Pinch or double-tap a page to zoom; drag to move around while zoomed.
       Pages draw as they come up next, not all at once, so long contracts
       don't eat the phone's memory. Desktop keeps the iframe. If pdf.js
       can't load, it falls back to the iframe too.

       window.FilePreview.renderPdf(bodyEl, url, name) — also used by
       Project Files' and Accounting's own preview popups. */
    const PDFJS_VERSION = "3.11.174";
    let pdfjsPromise = null;

    function loadPdfJs() {
        if (window.pdfjsLib) {
            if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
            }
            return Promise.resolve(window.pdfjsLib);
        }
        if (pdfjsPromise) return pdfjsPromise;
        pdfjsPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`;
            script.onload = () => {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
                resolve(window.pdfjsLib);
            };
            script.onerror = () => { pdfjsPromise = null; reject(new Error("pdf.js didn't load")); };
            document.head.appendChild(script);
        });
        return pdfjsPromise;
    }

    function isPhone() {
        return window.matchMedia("(max-width: 768px)").matches;
    }

    function iframePdf(body, url, name) {
        body.innerHTML = `<iframe class="file-preview-frame" title="${esc(name || "Document")}"></iframe>`;
        body.querySelector("iframe").src = url;
    }

    function destroyPdf(body) {
        if (body && body._pdfDoc) {
            body._pdfDoc.destroy();
            body._pdfDoc = null;
        }
    }

    async function renderPdf(body, url, name) {
        destroyPdf(body);
        if (!isPhone()) { iframePdf(body, url, name); return; }

        body.innerHTML = `<div class="file-preview-loading">Loading preview…</div>`;
        const loadingEl = body.firstElementChild;
        let doc;
        try {
            const lib = await loadPdfJs();
            doc = await lib.getDocument({ url }).promise;
        } catch (err) {
            console.error("Phone PDF viewer failed, using the browser's:", err);
            if (loadingEl.isConnected) iframePdf(body, url, name);
            return;
        }
        // Closed, or another file opened, while it was loading.
        if (!loadingEl.isConnected) { doc.destroy(); return; }
        body._pdfDoc = doc;

        const total = doc.numPages;
        const showDots = total > 1 && total <= 10;
        body.innerHTML = `
            <div class="pdf-swipe">
                <div class="pdf-swipe-track">
                    ${Array.from({ length: total }, (_, i) => `
                        <div class="pdf-swipe-page" data-page="${i + 1}">
                            <div class="file-preview-loading">Page ${i + 1}</div>
                        </div>`).join("")}
                </div>
                ${total > 1 ? `
                <div class="pdf-swipe-footer">
                    ${showDots ? `<div class="pdf-swipe-dots">${Array.from({ length: total }, (_, i) => `<span class="pdf-swipe-dot${i === 0 ? " is-active" : ""}"></span>`).join("")}</div>` : ""}
                    <span class="pdf-swipe-count">1 / ${total}</span>
                </div>` : ""}
            </div>`;

        const track = body.querySelector(".pdf-swipe-track");
        const dots = body.querySelectorAll(".pdf-swipe-dot");
        const count = body.querySelector(".pdf-swipe-count");
        const drawn = new Set();

        const dpr = Math.min(2, window.devicePixelRatio || 1); // sharp, but capped for memory
        const MAX_ZOOM = 8;
        const MAX_PIXELS = 12e6; // stay well under iPhone's canvas size limit

        // Draws page n at `scale` (pdf.js units) and returns a JPEG data URL.
        async function renderPage(n, scale) {
            const page = await doc.getPage(n);
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            const src = canvas.toDataURL("image/jpeg", 0.92);
            canvas.width = canvas.height = 0; // free the canvas memory right away
            return { src, px: viewport.width };
        }

        async function drawPage(slide) {
            const n = Number(slide.dataset.page);
            if (drawn.has(n)) return;
            drawn.add(n);
            try {
                const page = await doc.getPage(n);
                const base = page.getViewport({ scale: 1 });
                // Fit the whole page inside the slide (width and height).
                const fit = Math.min((slide.clientWidth - 8) / base.width, (slide.clientHeight - 8) / base.height);
                const { src, px } = await renderPage(n, fit * dpr);
                const img = document.createElement("img");
                img.className = "pdf-swipe-img";
                img.alt = `${name || "Document"} — page ${n}`;
                img.draggable = false;
                slide._zoom = { fit, base, scale: 1, w: Math.floor(base.width * fit), h: Math.floor(base.height * fit), px };
                img.style.width = `${slide._zoom.w}px`;
                img.src = src;
                slide.replaceChildren(img);
            } catch (err) {
                if (!body._pdfDoc) return; // closed mid-draw
                console.error(`PDF page ${n} failed:`, err);
                slide.innerHTML = `<div class="file-preview-error">Couldn't show page ${n}.</div>`;
            }
        }

        // Draw the page on screen plus the next one over, as you swipe.
        const observer = new IntersectionObserver(entries => {
            entries.forEach(e => { if (e.isIntersecting) drawPage(e.target); });
        }, { root: track, rootMargin: "0px 100%" });
        track.querySelectorAll(".pdf-swipe-page").forEach(s => observer.observe(s));

        let currentIndex = 0;
        track.addEventListener("scroll", () => {
            const i = Math.round(track.scrollLeft / track.clientWidth);
            if (i === currentIndex) return;
            currentIndex = i;
            dots.forEach((d, j) => d.classList.toggle("is-active", j === i));
            if (count) count.textContent = `${i + 1} / ${total}`;
            // Leaving a page puts it back to normal size.
            track.querySelectorAll(".pdf-swipe-page.is-zoomed").forEach(s => setZoom(s, 1));
        }, { passive: true });

        /* ---------- Zoom: pinch, or double-tap (2.5x / back to fit) ----------
           A zoomed page becomes its own scroll box, so one finger pans
           around it. While zoomed it doesn't swipe to the next page or
           drag the sheet closed (data-no-swipe) — double-tap or pinch back
           out first. After zooming, the page is redrawn sharper. */
        function setZoom(slide, scale, cx, cy) {
            const z = slide._zoom;
            const img = slide.querySelector(".pdf-swipe-img");
            if (!z || !img) return;
            scale = Math.min(MAX_ZOOM, Math.max(1, scale));

            // Keep the point under the fingers in the same spot.
            const sr = slide.getBoundingClientRect();
            const ir = img.getBoundingClientRect();
            if (cx == null) { cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
            const fx = (cx - ir.left) / ir.width;
            const fy = (cy - ir.top) / ir.height;

            z.scale = scale;
            const zoomed = scale > 1.01;
            slide.classList.toggle("is-zoomed", zoomed);
            slide.toggleAttribute("data-no-swipe", zoomed);
            const w = z.w * scale;
            const h = z.h * scale;
            img.style.width = `${w}px`;

            const offX = Math.max(0, (slide.clientWidth - w) / 2);
            const offY = Math.max(0, (slide.clientHeight - h) / 2);
            slide.scrollLeft = fx * w + offX - (cx - sr.left);
            slide.scrollTop = fy * h + offY - (cy - sr.top);
        }

        let sharpenTimer = null;
        function sharpen(slide) {
            clearTimeout(sharpenTimer);
            sharpenTimer = setTimeout(async () => {
                const z = slide._zoom;
                if (!z || z.scale <= 1.01) return;
                let scale = z.fit * z.scale * dpr;
                const pixels = (z.base.width * scale) * (z.base.height * scale);
                if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
                if (z.base.width * scale < z.px * 1.2) return; // already sharp enough
                try {
                    const { src, px } = await renderPage(Number(slide.dataset.page), scale);
                    const img = slide.querySelector(".pdf-swipe-img");
                    if (img && body._pdfDoc) { img.src = src; z.px = px; }
                } catch (err) {
                    console.error("PDF zoom redraw failed:", err);
                }
            }, 250);
        }

        let pinch = null;
        let lastTap = null;
        const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

        track.addEventListener("touchstart", e => {
            const slide = e.target.closest(".pdf-swipe-page");
            if (!slide || !slide._zoom) return;
            if (e.touches.length === 2) {
                const [a, b] = e.touches;
                pinch = { slide, startDist: dist(a, b), startScale: slide._zoom.scale };
                lastTap = null;
            }
        }, { passive: true });

        track.addEventListener("touchmove", e => {
            if (!pinch || e.touches.length !== 2) return;
            e.preventDefault(); // we're zooming, not swiping
            const [a, b] = e.touches;
            setZoom(pinch.slide, pinch.startScale * dist(a, b) / pinch.startDist,
                (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        }, { passive: false });

        track.addEventListener("touchend", e => {
            if (pinch) {
                if (e.touches.length < 2) {
                    const slide = pinch.slide;
                    pinch = null;
                    if (slide._zoom.scale < 1.08) setZoom(slide, 1);
                    else sharpen(slide);
                }
                return;
            }
            // Double-tap: zoom in where you tapped, or back out to fit.
            if (e.changedTouches.length !== 1 || e.touches.length) return;
            const slide = e.target.closest(".pdf-swipe-page");
            if (!slide || !slide._zoom) return;
            const t = e.changedTouches[0];
            const now = e.timeStamp;
            if (lastTap && now - lastTap.t < 300 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30) {
                e.preventDefault();
                lastTap = null;
                if (slide._zoom.scale > 1.01) setZoom(slide, 1);
                else { setZoom(slide, 2.5, t.clientX, t.clientY); sharpen(slide); }
            } else {
                lastTap = { t: now, x: t.clientX, y: t.clientY };
            }
        }, { passive: false });
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

    window.FilePreview = { open, close, download, renderPdf };
})();
