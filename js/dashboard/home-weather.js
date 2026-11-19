/* ============================================================================
   home-weather.js — weather in the Home page's glass bar (2026-11-18).
   Replaces weather.js on pages/dashboard.html (weather.js is left as is).

   Open-Meteo, no API key. Adds a location picker: search a city or ZIP,
   use the browser's current location, or pick an active project's site.
   The choice is saved per person in this browser.
============================================================================ */
(function () {
  "use strict";

  const WEATHER_CONFIG = { city: "Wilmington", state: "North Carolina", country: "US" };
  const GEOCODE_CACHE_KEY = "weatherGeocodeCacheV2";

  const WMO_CODES = {
    0: { icon: "☀️", label: "Clear sky" },
    1: { icon: "🌤️", label: "Mainly clear" },
    2: { icon: "⛅", label: "Partly cloudy" },
    3: { icon: "☁️", label: "Overcast" },
    45: { icon: "🌫️", label: "Fog" },
    48: { icon: "🌫️", label: "Rime fog" },
    51: { icon: "🌦️", label: "Light drizzle" },
    53: { icon: "🌦️", label: "Drizzle" },
    55: { icon: "🌧️", label: "Dense drizzle" },
    56: { icon: "🌧️", label: "Freezing drizzle" },
    57: { icon: "🌧️", label: "Freezing drizzle" },
    61: { icon: "🌦️", label: "Light rain" },
    63: { icon: "🌧️", label: "Rain" },
    65: { icon: "🌧️", label: "Heavy rain" },
    66: { icon: "🌧️", label: "Freezing rain" },
    67: { icon: "🌧️", label: "Freezing rain" },
    71: { icon: "🌨️", label: "Light snow" },
    73: { icon: "🌨️", label: "Snow" },
    75: { icon: "❄️", label: "Heavy snow" },
    77: { icon: "❄️", label: "Snow grains" },
    80: { icon: "🌦️", label: "Rain showers" },
    81: { icon: "🌧️", label: "Rain showers" },
    82: { icon: "⛈️", label: "Violent showers" },
    85: { icon: "🌨️", label: "Snow showers" },
    86: { icon: "❄️", label: "Snow showers" },
    95: { icon: "⛈️", label: "Thunderstorm" },
    96: { icon: "⛈️", label: "Thunderstorm w/ hail" },
    99: { icon: "⛈️", label: "Thunderstorm w/ hail" },
  };

  async function getCoordinates() {
    try {
      const cached = JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || "null");
      if (cached && cached.city === WEATHER_CONFIG.city) return cached;
    } catch (_) {
      /* ignore bad cache */
    }

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      WEATHER_CONFIG.city
    )}&count=10&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Geocoding request failed");
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) throw new Error("No geocoding match for configured city");

    const match =
      results.find(
        (r) => r.country_code === WEATHER_CONFIG.country && r.admin1 === WEATHER_CONFIG.state
      ) || results[0];

    const coords = { city: WEATHER_CONFIG.city, lat: match.latitude, lon: match.longitude };
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(coords));
    return coords;
  }



  const DEFAULT_LOC = { site: "Main office", label: "Wilmington, NC", city: WEATHER_CONFIG.city, state: WEATHER_CONFIG.state };
  const STATE_ABBR = { "North Carolina": "NC", "South Carolina": "SC", Virginia: "VA", Georgia: "GA", Florida: "FL", Tennessee: "TN" };

  let currentLoc = null;   // { site?, label, lat, lon }
  let lastData = null;     // the forecast behind the number on screen

  function userKey() {
    let p = window.currentSupabaseProfile;
    if (!p) { try { p = JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch (_) { p = null; } }
    return `homeWeatherLocation:${(p && (p.id || p.auth_user_id || p.email)) || "anon"}`;
  }
  function savedLocation() {
    try { const v = JSON.parse(localStorage.getItem(userKey()) || "null"); if (v && v.lat != null) return v; } catch (_) { /* bad value */ }
    return null;
  }
  function saveLocation(loc) {
    try { localStorage.setItem(userKey(), JSON.stringify(loc)); } catch (_) { /* private mode */ }
  }
  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
  }
  const r = (n) => (n == null || Number.isNaN(n) ? "—" : Math.round(n));
  /* ---------- weather icons ----------
     Drawn here as SVG (not emoji) so they look the same on every phone,
     computer and browser. 32×32, colors fixed. */
  const C = { sun: "#f5a524", moon: "#8ea6c9", cloud: "#b9c7d6", cloudDark: "#93a4b8", rain: "#2f7fc1", snow: "#7fb2e5", bolt: "#f5a524", fog: "#9aa6b2" };
  const sunShape = (cx, cy, r, ray) => {
    let rays = "";
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
      rays += `<line x1="${(cx + c * (r + 2.2)).toFixed(1)}" y1="${(cy + s * (r + 2.2)).toFixed(1)}" x2="${(cx + c * (r + 2.2 + ray)).toFixed(1)}" y2="${(cy + s * (r + 2.2 + ray)).toFixed(1)}"/>`;
    }
    return `<g stroke="${C.sun}" stroke-width="2" stroke-linecap="round">${rays}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.sun}"/>`;
  };
  const moonShape = (cx, cy, r) =>
    `<path fill="${C.moon}" d="M${cx + r * 0.35} ${cy - r}a${r} ${r} 0 1 0 ${r * 0.65} ${r * 1.55}A${r * 0.8} ${r * 0.8} 0 0 1 ${cx + r * 0.35} ${cy - r}z"/>`;
  const cloudShape = (dy = 0, fill = C.cloud) =>
    `<g fill="${fill}" transform="translate(0 ${dy})"><circle cx="11" cy="20.5" r="4.5"/><circle cx="17" cy="17" r="6.5"/><circle cx="23" cy="21" r="4"/><rect x="11" y="20" width="12" height="5"/></g>`;
  const drops = (n, kind) => {
    const xs = n === 2 ? [12, 20] : [10.5, 16, 21.5];
    return xs.map((x, i) => kind === "snow"
      ? `<g stroke="${C.snow}" stroke-width="1.4" stroke-linecap="round" transform="translate(${x} ${27 + (i % 2) * 1.5})"><line x1="0" y1="-2.2" x2="0" y2="2.2"/><line x1="-1.9" y1="-1.1" x2="1.9" y2="1.1"/><line x1="-1.9" y1="1.1" x2="1.9" y2="-1.1"/></g>`
      : kind === "drizzle"
        ? `<circle cx="${x}" cy="${27.5 + (i % 2) * 1.5}" r="1.1" fill="${C.rain}"/>`
        : `<line x1="${x + 1}" y1="25.5" x2="${x - 0.5}" y2="29.5" stroke="${C.rain}" stroke-width="2" stroke-linecap="round"/>`).join("");
  };
  const svg = (body) => `<svg class="wx-svg" viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;
  const WX = {
    sun: () => svg(sunShape(16, 16, 6, 3)),
    moon: () => svg(moonShape(15, 16, 9)),
    partlyDay: () => svg(sunShape(11.5, 11, 4.5, 2.2) + cloudShape(2)),
    partlyNight: () => svg(moonShape(11, 11.5, 7.5) + cloudShape(3)),
    cloud: () => svg(cloudShape(-5, C.cloudDark) + cloudShape(1)),
    fog: () => svg(cloudShape(-5) + `<g stroke="${C.fog}" stroke-width="2" stroke-linecap="round"><line x1="6" y1="24" x2="26" y2="24"/><line x1="9" y1="28" x2="23" y2="28"/></g>`),
    drizzle: () => svg(cloudShape(-4) + drops(3, "drizzle")),
    rain: () => svg(cloudShape(-4) + drops(3, "rain")),
    snow: () => svg(cloudShape(-4) + drops(3, "snow")),
    sleet: () => svg(cloudShape(-4) + drops(2, "rain") + `<circle cx="16" cy="28" r="1.5" fill="${C.snow}"/>`),
    thunder: () => svg(cloudShape(-4, C.cloudDark) + `<path d="M17.5 21l-4 6h3l-1.5 4.5 5-6.5h-3l1.5-4z" fill="${C.bolt}"/>`),
    sunrise: () => svg(`<line x1="4" y1="24" x2="28" y2="24" stroke="${C.fog}" stroke-width="2" stroke-linecap="round"/><path d="M9 24a7 7 0 0 1 14 0z" fill="${C.sun}"/><path d="M16 6v8M12.5 9.5 16 6l3.5 3.5" fill="none" stroke="${C.sun}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
    sunset: () => svg(`<line x1="4" y1="24" x2="28" y2="24" stroke="${C.fog}" stroke-width="2" stroke-linecap="round"/><path d="M9 24a7 7 0 0 1 14 0z" fill="${C.sun}"/><path d="M16 6v8M12.5 10.5 16 14l3.5-3.5" fill="none" stroke="${C.sun}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  };
  window.HomeWeatherIcons = WX;
  function kindOf(c, isDay) {
    const night = isDay === 0;
    if (c === 0) return night ? "moon" : "sun";
    if (c === 1 || c === 2) return night ? "partlyNight" : "partlyDay";
    if (c === 3) return "cloud";
    if (c === 45 || c === 48) return "fog";
    if (c >= 51 && c <= 55) return "drizzle";
    if (c === 56 || c === 57 || c === 66 || c === 67) return "sleet";
    if ((c >= 61 && c <= 65) || (c >= 80 && c <= 82)) return "rain";
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
    if (c >= 95) return "thunder";
    return "cloud";
  }
  function codeOf(c, isDay) {
    const base = WMO_CODES[c] || { label: "—" };
    return { icon: WX[kindOf(c, isDay)](), label: isDay === 0 && c === 0 ? "Clear" : base.label };
  }
  // "2026-11-19T17:04" → "5:04p"
  function clock(t) {
    const hr = Number(t.slice(11, 13)), mi = t.slice(14, 16);
    return `${hr % 12 || 12}:${mi}${hr < 12 ? "a" : "p"}`;
  }
  function placeText(loc) { return loc.site ? `${loc.site} · ${loc.label}` : loc.label; }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!document.getElementById("weatherBody")) return;
    wirePicker();
    wireForecast();
    let loc = savedLocation();
    if (!loc) {
      try { const c = await getCoordinates(); loc = { site: DEFAULT_LOC.site, label: DEFAULT_LOC.label, lat: c.lat, lon: c.lon }; }
      catch (e) { console.error("home-weather: geocoding failed", e); return; }
    }
    showLocation(loc);
  });

  async function showLocation(loc) {
    currentLoc = loc;
    const labelEl = document.getElementById("weatherLocation");
    if (labelEl) {
      labelEl.innerHTML = loc.site ? `<strong>${esc(loc.site)}</strong> · ${esc(loc.label)}` : esc(loc.label);
      labelEl.title = placeText(loc);
    }
    try {
      lastData = await fetchWeather(loc.lat, loc.lon);
      renderWeather(lastData);
      const link = document.getElementById("viewFullForecastLink");
      if (link) link.href = `https://forecast.weather.gov/MapClick.php?lat=${loc.lat}&lon=${loc.lon}`;
      const sheet = document.getElementById("weatherForecastSheet");
      if (sheet && !sheet.classList.contains("hidden")) renderForecast();
    } catch (err) {
      console.error("home-weather: failed to load weather", err);
      document.getElementById("weatherBody").textContent = "—";
      const desc = document.getElementById("weatherDesc");
      if (desc) desc.textContent = "Unavailable";
    }
  }

  // One request feeds both the glass bar and the forecast pop-up, so they always match.
  async function fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,is_day` +
      `&hourly=temperature_2m,weather_code,precipitation_probability,is_day` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Forecast request failed");
    return res.json();
  }

  function renderWeather(data) {
    const current = data.current || {};
    const code = codeOf(current.weather_code, current.is_day);
    document.getElementById("weatherBody").textContent = `${r(current.temperature_2m)}°`;
    const desc = document.getElementById("weatherDesc");
    if (desc) desc.textContent = code.label;
    const icon = document.getElementById("weatherIcon");
    if (icon) { icon.innerHTML = code.icon; icon.title = code.label; }
  }

  /* ---------- forecast pop-up ---------- */

  function compass(deg) {
    if (deg == null) return "";
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
  }

  function renderForecast() {
    if (!lastData || !currentLoc) return;
    const c = lastData.current || {};
    const h = lastData.hourly || {};
    const d = lastData.daily || {};
    const code = codeOf(c.weather_code, c.is_day);
    document.getElementById("wfPlace").textContent = placeText(currentLoc);
    document.getElementById("wfIcon").innerHTML = code.icon;
    document.getElementById("wfTemp").textContent = `${r(c.temperature_2m)}°`;
    document.getElementById("wfDesc").innerHTML = `${esc(code.label)} <span class="hm-nowrap">· H ${r(d.temperature_2m_max?.[0])}°  L ${r(d.temperature_2m_min?.[0])}°</span>`;
    document.getElementById("wfFeels").textContent = `${r(c.apparent_temperature)}°`;
    document.getElementById("wfWind").textContent = `${r(c.wind_speed_10m)} mph ${compass(c.wind_direction_10m)}`.trim();
    document.getElementById("wfHumidity").textContent = `${r(c.relative_humidity_2m)}%`;
    document.getElementById("wfRain").textContent = `${r(d.precipitation_probability_max?.[0])}%`;
    const sunEl = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t ? clock(t).replace(/([ap])$/, " $1M").toUpperCase() : "—"; };
    document.querySelectorAll(".wx-dt[data-wx]").forEach(el => { if (!el.firstChild) el.innerHTML = WX[el.dataset.wx](); });
    sunEl("wfSunrise", d.sunrise?.[0]);
    sunEl("wfSunset", d.sunset?.[0]);

    // Next 24 hours from the current hour (times are local to the place),
    // with sunrise and sunset dropped in where they happen.
    const times = h.time || [];
    const nowHour = (c.time || "").slice(0, 13);
    let start = times.findIndex(t => t.slice(0, 13) >= nowHour);
    if (start < 0) start = 0;
    const sunEvents = [
      ...(d.sunrise || []).map(t => ({ t, kind: "Sunrise", icon: WX.sunrise() })),
      ...(d.sunset || []).map(t => ({ t, kind: "Sunset", icon: WX.sunset() })),
    ].filter(e => e.t).sort((a, b) => a.t.localeCompare(b.t));
    const cells = [];
    times.slice(start, start + 24).forEach((t, i) => {
      const idx = start + i;
      const hr = Number(t.slice(11, 13));
      const label = i === 0 ? "Now" : `${hr % 12 || 12}${hr < 12 ? "a" : "p"}`;
      // "Now" uses the same current reading as the big number, so they match.
      const cc = i === 0 ? codeOf(c.weather_code, c.is_day) : codeOf(h.weather_code?.[idx], h.is_day?.[idx]);
      const rain = h.precipitation_probability?.[idx];
      const temp = i === 0 ? c.temperature_2m : h.temperature_2m?.[idx];
      cells.push(`<div class="hm-fc-hour"><span class="hm-fc-hour-t">${label}</span><span class="hm-fc-hour-i" title="${esc(cc.label)}">${cc.icon}</span><strong>${r(temp)}°</strong><span class="hm-fc-hour-r">${rain ? rain + "%" : "&nbsp;"}</span></div>`);
      // A sunrise/sunset during this hour (and after "now") goes right after it.
      const hourEnd = times[idx + 1] || "9999";
      const from = i === 0 ? (c.time || t) : t;
      sunEvents.filter(e => e.t >= from && e.t < hourEnd).forEach(e => {
        cells.push(`<div class="hm-fc-hour hm-fc-hour--sun"><span class="hm-fc-hour-t">${clock(e.t)}</span><span class="hm-fc-hour-i" title="${e.kind}">${e.icon}</span><strong>${e.kind}</strong><span class="hm-fc-hour-r">&nbsp;</span></div>`);
      });
    });
    document.getElementById("wfHours").innerHTML = cells.join("");

    const hoursEl = document.getElementById("wfHours");
    hoursEl.scrollLeft = 0;
    requestAnimationFrame(updateHoursScroll);

    // 7 days, with a bar showing each day's range against the week's.
    const lows = d.temperature_2m_min || [], highs = d.temperature_2m_max || [];
    const wkLo = Math.min(...lows), wkHi = Math.max(...highs), span = Math.max(1, wkHi - wkLo);
    document.getElementById("wfDays").innerHTML = (d.time || []).map((t, i) => {
      const [y, m, dd] = t.split("-").map(Number);
      const day = i === 0 ? "Today" : new Date(y, m - 1, dd).toLocaleDateString("en-US", { weekday: "short" });
      const cc = codeOf(d.weather_code?.[i]);
      const rain = d.precipitation_probability_max?.[i];
      const left = ((lows[i] - wkLo) / span) * 100, width = ((highs[i] - lows[i]) / span) * 100;
      return `<div class="hm-fc-day"><span class="hm-fc-day-n">${day}</span><span class="hm-fc-day-i" title="${esc(cc.label)}">${cc.icon}</span><span class="hm-fc-day-r">${rain ? rain + "%" : ""}</span><span class="hm-fc-lo">${r(lows[i])}°</span><span class="hm-fc-bar"><span style="left:${left}%;width:${Math.max(4, width)}%"></span></span><span class="hm-fc-hi">${r(highs[i])}°</span></div>`;
    }).join("");
  }

  /* Hours strip: fades + arrows show there's more; arrows step 3 hours;
     a mouse wheel scrolls it sideways while the pointer is over it. */
  function updateHoursScroll() {
    const strip = document.getElementById("wfHours");
    const card = document.getElementById("wfHoursCard");
    if (!strip || !card) return;
    const max = strip.scrollWidth - strip.clientWidth;
    card.classList.toggle("can-left", strip.scrollLeft > 4);
    card.classList.toggle("can-right", strip.scrollLeft < max - 4);
  }

  function wireHoursScroll() {
    const strip = document.getElementById("wfHours");
    if (!strip) return;
    const step = () => (strip.querySelector(".hm-fc-hour")?.offsetWidth || 60) * 3;
    document.getElementById("wfHoursPrev").addEventListener("click", () => strip.scrollBy({ left: -step(), behavior: "smooth" }));
    document.getElementById("wfHoursNext").addEventListener("click", () => strip.scrollBy({ left: step(), behavior: "smooth" }));
    strip.addEventListener("scroll", updateHoursScroll, { passive: true });
    strip.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = strip.scrollWidth - strip.clientWidth;
      if ((e.deltaY < 0 && strip.scrollLeft <= 0) || (e.deltaY > 0 && strip.scrollLeft >= max)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    }, { passive: false });
    window.addEventListener("resize", updateHoursScroll);
  }

  function wireForecast() {
    wireHoursScroll();
    const sheet = document.getElementById("weatherForecastSheet");
    const open = document.getElementById("weatherOpenForecast");
    if (!sheet || !open) return;
    const close = () => {
      if (window.HomeWeatherPicker) window.HomeWeatherPicker.close();
      sheet.classList.add("hidden");
      if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
    };
    open.addEventListener("click", () => {
      if (!lastData) return;
      renderForecast();
      sheet.classList.remove("hidden");
      document.body.classList.add("popup-active");
    });
    document.getElementById("wfClose").addEventListener("click", close);
    sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.classList.contains("hidden")) close(); });
    // Tap the place name to change the location right here.
    const placeBtn = document.getElementById("wfPlaceBtn");
    placeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.HomeWeatherPicker) window.HomeWeatherPicker.toggle(sheet.querySelector(".hm-fc-head"), placeBtn);
    });
  }

  /* ---------- location picker ---------- */

  async function geocode(query, count) {
    const q = query.trim();
    const zip = /^\d{5}$/.test(q);
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=${count || 6}&language=en&format=json${zip ? "&countryCode=US" : ""}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(x => ({
      label: `${x.name}${x.admin1 ? ", " + (STATE_ABBR[x.admin1] || x.admin1) : ""}${x.country_code && x.country_code !== "US" ? ", " + x.country_code : ""}`,
      lat: x.latitude, lon: x.longitude, state: x.admin1
    }));
  }

  // A project's spot: ZIP first (closest), then city + state.
  async function locateSite(site) {
    if (site.zip && /^\d{5}/.test(site.zip)) {
      const hit = (await geocode(site.zip.slice(0, 5), 3).catch(() => []))[0];
      if (hit) return hit;
    }
    if (!site.city) return null;
    const st = (site.state || "").toLowerCase();
    const hits = await geocode(site.city, 10).catch(() => []);
    return hits.find(h => !st || (h.state || "").toLowerCase() === st || h.label.toLowerCase().endsWith(", " + st)) || hits[0] || null;
  }

  function wirePicker() {
    const btn = document.getElementById("weatherLocationBtn");
    const pop = document.getElementById("weatherLocationPop");
    const search = document.getElementById("weatherLocationSearch");
    const results = document.getElementById("weatherLocationResults");
    const resultsLabel = document.getElementById("weatherLocationResultsLabel");
    const here = document.getElementById("weatherUseMyLocation");
    const sitesWrap = document.getElementById("weatherLocationSites");
    if (!btn || !pop) return;
    let sites = null;

    // The picker normally hangs under the button in the glass bar; the
    // forecast pop-up borrows it (opened from the place name in its header).
    const home = pop.parentElement;
    let anchor = btn;
    function setOpen(yes, host, anchorBtn) {
      if (yes) {
        const h = host || home;
        if (pop.parentElement !== h) h.appendChild(pop);
        anchor.setAttribute("aria-expanded", "false");
        anchor = anchorBtn || btn;
      }
      pop.hidden = !yes;
      anchor.setAttribute("aria-expanded", String(yes));
      if (!yes && pop.parentElement !== home) home.appendChild(pop);
      if (yes) {
        if (search) search.value = "";
        results.innerHTML = ""; resultsLabel.hidden = true;
        loadSites().then(() => renderSites(""));
        setTimeout(() => search && search.focus(), 30);
      }
    }
    btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(pop.hidden || anchor !== btn); });
    document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && !anchor.contains(e.target)) setOpen(false); });
    pop.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // don't also close the forecast
      const a = anchor; setOpen(false); a.focus();
    });
    window.HomeWeatherPicker = {
      toggle(host, anchorBtn) { if (!pop.hidden && anchor === anchorBtn) setOpen(false); else setOpen(true, host, anchorBtn); },
      close() { if (!pop.hidden) setOpen(false); }
    };

    function choose(loc) { saveLocation(loc); showLocation(loc); setOpen(false); }

    function optionButton(title, sub, selected, disabled, onPick) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `hm-loc-option${selected ? " is-selected" : ""}`;
      b.disabled = !!disabled;
      b.innerHTML = `<span><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</span>${selected ? '<span class="hm-check" aria-label="Selected">✓</span>' : ""}`;
      b.addEventListener("click", onPick);
      return b;
    }

    async function loadSites() {
      if (sites) return;
      sites = [{ name: DEFAULT_LOC.site, city: DEFAULT_LOC.city, state: DEFAULT_LOC.state, zip: "", label: DEFAULT_LOC.label }];
      if (!window.supabaseClient) return;
      const { data, error } = await window.supabaseClient.from("projects")
        .select("name, site_city, site_state, site_zip, status").neq("status", "archived").order("name");
      if (error) console.warn("home-weather: couldn't load projects", error);
      (data || []).forEach(p => {
        const st = STATE_ABBR[p.site_state] || p.site_state || "";
        sites.push({
          name: p.name || "Untitled project", city: p.site_city || "", state: p.site_state || "", zip: p.site_zip || "",
          label: p.site_city ? `${p.site_city}${st ? ", " + st : ""}` : (p.site_zip || "")
        });
      });
    }

    function renderSites(filter) {
      const f = filter.trim().toLowerCase();
      const list = (sites || []).filter(sv => !f || sv.name.toLowerCase().includes(f) || sv.label.toLowerCase().includes(f));
      sitesWrap.innerHTML = list.length ? "" : '<p class="hm-loc-empty">No projects match.</p>';
      list.forEach(site => {
        const selected = currentLoc && currentLoc.site === site.name;
        const noAddress = !site.city && !site.zip;
        sitesWrap.appendChild(optionButton(site.name, noAddress ? "No address on file" : site.label, selected, noAddress, async () => {
          const hit = await locateSite(site);
          if (hit) choose({ site: site.name, label: site.label || hit.label, lat: hit.lat, lon: hit.lon });
        }));
      });
    }

    let timer = null;
    if (search) search.addEventListener("input", () => {
      const q = search.value;
      renderSites(q);
      clearTimeout(timer);
      if (q.trim().length < 2) { results.innerHTML = ""; resultsLabel.hidden = true; return; }
      timer = setTimeout(async () => {
        const list = await geocode(q).catch(() => []);
        resultsLabel.hidden = !list.length;
        results.innerHTML = "";
        list.forEach(l => results.appendChild(optionButton(l.label, "", false, false, () => choose({ label: l.label, lat: l.lat, lon: l.lon }))));
      }, 300);
    });

    if (here) here.addEventListener("click", () => {
      if (!navigator.geolocation) { here.textContent = "Location isn't available in this browser"; return; }
      here.disabled = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => { here.disabled = false; choose({ label: "Current location", lat: pos.coords.latitude, lon: pos.coords.longitude }); },
        () => { here.disabled = false; here.textContent = "Location is blocked in this browser"; },
        { timeout: 10000 }
      );
    });
  }
})();
