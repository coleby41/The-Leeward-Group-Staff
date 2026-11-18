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
  function codeOf(c) { return WMO_CODES[c] || { icon: "🌡️", label: "—" }; }
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
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code` +
      `&hourly=temperature_2m,weather_code,precipitation_probability` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Forecast request failed");
    return res.json();
  }

  function renderWeather(data) {
    const current = data.current || {};
    const code = codeOf(current.weather_code);
    document.getElementById("weatherBody").textContent = `${r(current.temperature_2m)}°`;
    const desc = document.getElementById("weatherDesc");
    if (desc) desc.textContent = code.label;
    const icon = document.getElementById("weatherIcon");
    if (icon) { icon.textContent = code.icon; icon.title = code.label; }
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
    const code = codeOf(c.weather_code);
    document.getElementById("wfPlace").textContent = placeText(currentLoc);
    document.getElementById("wfIcon").textContent = code.icon;
    document.getElementById("wfTemp").textContent = `${r(c.temperature_2m)}°`;
    document.getElementById("wfDesc").innerHTML = `${esc(code.label)} <span class="hm-nowrap">· H ${r(d.temperature_2m_max?.[0])}°  L ${r(d.temperature_2m_min?.[0])}°</span>`;
    document.getElementById("wfFeels").textContent = `${r(c.apparent_temperature)}°`;
    document.getElementById("wfWind").textContent = `${r(c.wind_speed_10m)} mph ${compass(c.wind_direction_10m)}`.trim();
    document.getElementById("wfHumidity").textContent = `${r(c.relative_humidity_2m)}%`;
    document.getElementById("wfRain").textContent = `${r(d.precipitation_probability_max?.[0])}%`;

    // Next 12 hours from the current hour (times are local to the place).
    const times = h.time || [];
    const nowHour = (c.time || "").slice(0, 13);
    let start = times.findIndex(t => t.slice(0, 13) >= nowHour);
    if (start < 0) start = 0;
    document.getElementById("wfHours").innerHTML = times.slice(start, start + 12).map((t, i) => {
      const idx = start + i;
      const hr = Number(t.slice(11, 13));
      const label = i === 0 ? "Now" : `${hr % 12 || 12}${hr < 12 ? "a" : "p"}`;
      // "Now" uses the same current reading as the big number, so they match.
      const cc = codeOf(i === 0 ? c.weather_code : h.weather_code?.[idx]);
      const rain = h.precipitation_probability?.[idx];
      const temp = i === 0 ? c.temperature_2m : h.temperature_2m?.[idx];
      return `<div class="hm-fc-hour"><span class="hm-fc-hour-t">${label}</span><span class="hm-fc-hour-i" title="${esc(cc.label)}">${cc.icon}</span><strong>${r(temp)}°</strong><span class="hm-fc-hour-r">${rain ? rain + "%" : "&nbsp;"}</span></div>`;
    }).join("");

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

  function wireForecast() {
    const sheet = document.getElementById("weatherForecastSheet");
    const open = document.getElementById("weatherOpenForecast");
    if (!sheet || !open) return;
    const close = () => {
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
    document.getElementById("wfDone").addEventListener("click", close);
    sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.classList.contains("hidden")) close(); });
    document.getElementById("wfChange").addEventListener("click", () => {
      close();
      document.getElementById("weatherLocationBtn").click();
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

    function setOpen(yes) {
      pop.hidden = !yes;
      btn.setAttribute("aria-expanded", String(yes));
      if (yes) {
        if (search) search.value = "";
        results.innerHTML = ""; resultsLabel.hidden = true;
        loadSites().then(() => renderSites(""));
        setTimeout(() => search && search.focus(), 30);
      }
    }
    btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(pop.hidden); });
    document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) setOpen(false); });
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { setOpen(false); btn.focus(); } });

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
