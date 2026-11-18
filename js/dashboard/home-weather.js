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



  const DEFAULT_LOC = { label: "Wilmington, NC", city: WEATHER_CONFIG.city, state: WEATHER_CONFIG.state };
  const STATE_ABBR = { "North Carolina": "NC", "South Carolina": "SC", Virginia: "VA", Georgia: "GA", Florida: "FL", Tennessee: "TN" };

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

  document.addEventListener("DOMContentLoaded", async () => {
    if (!document.getElementById("weatherBody")) return;
    wirePicker();
    let loc = savedLocation();
    if (!loc) {
      try { const c = await getCoordinates(); loc = { label: DEFAULT_LOC.label, lat: c.lat, lon: c.lon }; }
      catch (e) { console.error("home-weather: geocoding failed", e); return; }
    }
    showLocation(loc);
  });

  async function showLocation(loc) {
    const labelEl = document.getElementById("weatherLocation");
    if (labelEl) labelEl.textContent = loc.label;
    try {
      renderWeather(await fetchWeather(loc.lat, loc.lon));
      const link = document.getElementById("viewFullForecastLink");
      if (link) link.href = `https://forecast.weather.gov/MapClick.php?lat=${loc.lat}&lon=${loc.lon}`;
    } catch (err) {
      console.error("home-weather: failed to load weather", err);
      document.getElementById("weatherBody").textContent = "—";
      const desc = document.getElementById("weatherDesc");
      if (desc) desc.textContent = "Unavailable";
    }
  }

  async function fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Forecast request failed");
    return res.json();
  }

  function renderWeather(data) {
    const current = data.current || {};
    const code = WMO_CODES[current.weather_code] || { icon: "🌡️", label: "—" };
    document.getElementById("weatherBody").textContent = `${Math.round(current.temperature_2m)}°`;
    const desc = document.getElementById("weatherDesc");
    if (desc) desc.textContent = code.label;
    const icon = document.getElementById("weatherIcon");
    if (icon) { icon.textContent = code.icon; icon.title = code.label; }
  }

  async function geocode(query, count) {
    const q = query.trim();
    const zip = /^\d{5}$/.test(q);
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=${count || 6}&language=en&format=json${zip ? "&countryCode=US" : ""}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({
      label: `${r.name}${r.admin1 ? ", " + (STATE_ABBR[r.admin1] || r.admin1) : ""}${r.country_code && r.country_code !== "US" ? ", " + r.country_code : ""}`,
      lat: r.latitude, lon: r.longitude, state: r.admin1
    }));
  }

  function wirePicker() {
    const btn = document.getElementById("weatherLocationBtn");
    const pop = document.getElementById("weatherLocationPop");
    const search = document.getElementById("weatherLocationSearch");
    const results = document.getElementById("weatherLocationResults");
    const here = document.getElementById("weatherUseMyLocation");
    const sitesWrap = document.getElementById("weatherLocationSites");
    if (!btn || !pop) return;

    function setOpen(yes) {
      pop.hidden = !yes;
      btn.setAttribute("aria-expanded", String(yes));
      if (yes) { loadSites(); setTimeout(() => search && search.focus(), 30); }
    }
    btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(pop.hidden); });
    document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) setOpen(false); });
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { setOpen(false); btn.focus(); } });

    function choose(loc) { saveLocation(loc); showLocation(loc); setOpen(false); }

    function optionButton(title, sub, selected, onPick) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `hm-loc-option${selected ? " is-selected" : ""}`;
      b.innerHTML = `<span><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</span>${selected ? '<span class="hm-check" aria-label="Selected">✓</span>' : ""}`;
      b.addEventListener("click", onPick);
      return b;
    }

    let timer = null;
    if (search) search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 2) { results.innerHTML = ""; return; }
      timer = setTimeout(async () => {
        const list = await geocode(q).catch(() => []);
        results.innerHTML = list.length ? "" : '<p class="hm-loc-empty">No matches.</p>';
        list.forEach(l => results.appendChild(optionButton(l.label, "", false, () => choose({ label: l.label, lat: l.lat, lon: l.lon }))));
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

    async function loadSites() {
      const current = savedLocation();
      const sites = [{ name: "Main office", city: DEFAULT_LOC.city, state: DEFAULT_LOC.state, label: DEFAULT_LOC.label }];
      if (window.supabaseClient) {
        const { data } = await window.supabaseClient.from("projects")
          .select("name, site_city, site_state").eq("status", "active").order("name");
        (data || []).filter(p => p.site_city).forEach(p => sites.push({
          name: p.name, city: p.site_city, state: p.site_state,
          label: `${p.site_city}${p.site_state ? ", " + (STATE_ABBR[p.site_state] || p.site_state) : ""}`
        }));
      }
      sitesWrap.innerHTML = "";
      sites.slice(0, 8).forEach((site, i) => {
        const selected = current ? current.label === site.label && (current.site ? current.site === site.name : i === 0 || !sites.slice(0, i).some(s => s.label === site.label))
                                 : i === 0;
        sitesWrap.appendChild(optionButton(site.name, site.label, selected, async () => {
          const hits = await geocode(site.city, 10).catch(() => []);
          const st = (site.state || "").toLowerCase();
          const hit = hits.find(h => !st || (h.state || "").toLowerCase() === st || h.label.toLowerCase().endsWith(", " + st)) || hits[0];
          if (hit) choose({ label: site.label, site: site.name, lat: hit.lat, lon: hit.lon });
        }));
      });
    }
  }
})();
