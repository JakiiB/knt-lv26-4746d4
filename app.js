// AWS re:Invent 2026 Production Companion PWA Controller
// Zero external dependencies; offline-first with localStorage persistence and optional live Tides Sheet sync.

(function () {
  "use strict";

  const DATA = window.VEGAS_DATA;
  if (!DATA) return;

  const STORAGE_KEYS = {
    theme: "vegasProd26_theme_v1",
    tbc: "vegasProd26_tbc_v1",
    syncCfg: "vegasProd26_syncCfg_v1",
    syncOverlay: "vegasProd26_syncOverlay_v1",
    simIso: "vegasProd26_simIso_v1"
  };

  const VEGAS_TZ = "America/Los_Angeles";
  const SYDNEY_TZ = "Australia/Sydney";

  const venueMap = new Map(DATA.venues.map((v) => [v.id, v]));
  const contactMap = new Map(DATA.contacts.map((c) => [c.id, c]));

  const state = {
    view: "now",
    selectedDay: DATA.days[0].date,
    audienceFilter: "jake",
    mapFrom: "hgvc-flamingo",
    mapTo: "prestige-lounge",
    mapNextSlot: "to",
    contactQuery: "",
    tbc: loadJson(STORAGE_KEYS.tbc, structuredCloneFallback(DATA.tbcDefaults)),
    syncCfg: loadJson(STORAGE_KEYS.syncCfg, {
      url: "",
      token: DATA.meta.defaultSyncSecret || "",
      lastSyncedAt: "",
      lastSyncMsg: ""
    }),
    syncOverlay: loadJson(STORAGE_KEYS.syncOverlay, null),
    simIso: localStorage.getItem(STORAGE_KEYS.simIso) || ""
  };

  function structuredCloneFallback(obj) {
    return typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return Object.assign(structuredCloneFallback(fallback), parsed);
    } catch {
      return fallback;
    }
  }

  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      // Ignore storage quota errors
    }
  }

  // ---------- Offline-Safe Timezone & Duration Engine (Temporal + Intl Fallback) ----------

  function getVegasClockParts() {
    if (state.simIso) {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(state.simIso);
      if (m) {
        const hh = Number(m[2]);
        const mm = Number(m[3]);
        return {
          dateStr: m[1],
          hh,
          mm,
          minsOfDay: hh * 60 + mm,
          isSimulated: true
        };
      }
    }

    if (typeof Temporal !== "undefined" && Temporal.Now && Temporal.Now.zonedDateTimeISO) {
      const zdt = Temporal.Now.zonedDateTimeISO(VEGAS_TZ);
      return {
        dateStr: zdt.toPlainDate().toString(),
        hh: zdt.hour,
        mm: zdt.minute,
        minsOfDay: zdt.hour * 60 + zdt.minute,
        isSimulated: false
      };
    }

    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: VEGAS_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const hh = Number(parts.hour === "24" ? 0 : parts.hour);
    const mm = Number(parts.minute);
    return {
      dateStr: `${parts.year}-${parts.month}-${parts.day}`,
      hh,
      mm,
      minsOfDay: hh * 60 + mm,
      isSimulated: false
    };
  }

  function vegasEpochMs(dateStr, timeStr) {
    if (typeof Temporal !== "undefined" && Temporal.PlainDate) {
      const zdt = Temporal.PlainDate.from(dateStr).toPlainDateTime(`${timeStr}:00`).toZonedDateTime(VEGAS_TZ);
      return zdt.epochMilliseconds;
    }
    // Las Vegas in Nov/Dec is standard PST (-08:00)
    return Date.parse(`${dateStr}T${timeStr}:00-08:00`);
  }

  function getNowEpochMs() {
    const v = getVegasClockParts();
    if (v.isSimulated) {
      return vegasEpochMs(v.dateStr, `${String(v.hh).padStart(2, "0")}:${String(v.mm).padStart(2, "0")}`);
    }
    return Date.now();
  }

  function formatClock12(hh, mm) {
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    const ampm = hh >= 12 ? "PM" : "AM";
    return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
  }

  function formatTimeRange(start, end) {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    return `${formatClock12(sh, sm)} - ${formatClock12(eh, em)}`;
  }

  function formatDurationMinutes(totalMins) {
    const absMins = Math.max(0, Math.round(totalMins));
    const hours = Math.floor(absMins / 60);
    const mins = absMins % 60;
    if (typeof Intl !== "undefined" && Intl.DurationFormat) {
      try {
        return new Intl.DurationFormat("en-AU", { style: "narrow" }).format({
          hours: hours || undefined,
          minutes: mins || (hours === 0 ? 0 : undefined)
        });
      } catch {
        // Fallback below
      }
    }
    if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h`;
    return `${mins}m`;
  }

  function getDualClockStrings() {
    const v = getVegasClockParts();
    const nowMs = getNowEpochMs();
    const dObj = new Date(nowMs);
    const dayLabel = new Intl.DateTimeFormat("en-AU", {
      timeZone: VEGAS_TZ,
      weekday: "short",
      day: "numeric",
      month: "short"
    }).format(dObj).replace(",", "");
    const sydStr = new Intl.DateTimeFormat("en-AU", {
      timeZone: SYDNEY_TZ,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }).format(dObj);

    return {
      vegasText: `${formatClock12(v.hh, v.mm)} (${dayLabel})`,
      sydText: `SYD ${sydStr}`,
      isSimulated: v.isSimulated
    };
  }

  // ---------- Helpers: Escaping, Links, Transit Lookup ----------

  function esc(str) {
    return String(str === null || str === undefined ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mapsGpsUrl(venueId, mode) {
    const v = venueMap.get(venueId);
    if (!v) return "https://www.google.com/maps";
    const dest = encodeURIComponent(v.mapsQuery || v.address);
    return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=${mode || "walking"}`;
  }

  function mapsRouteUrl(fromId, toId, mode) {
    const vf = venueMap.get(fromId);
    const vt = venueMap.get(toId);
    if (!vt) return "https://www.google.com/maps";
    if (!vf || fromId === toId) return mapsGpsUrl(toId, mode);
    const orig = encodeURIComponent(vf.mapsQuery || vf.address);
    const dest = encodeURIComponent(vt.mapsQuery || vt.address);
    return `https://www.google.com/maps/dir/?api=1&origin=${orig}&destination=${dest}&travelmode=${mode || "walking"}`;
  }

  function whatsappUrl(phoneE164) {
    if (!phoneE164) return "";
    return `https://wa.me/${phoneE164}`;
  }

  function telUrl(phoneE164) {
    if (!phoneE164) return "";
    return `tel:+${phoneE164}`;
  }

  function smsUrl(phoneE164) {
    if (!phoneE164) return "";
    return `sms:+${phoneE164}`;
  }

  function resolveSuiteLabel(venueId) {
    const v = venueMap.get(venueId);
    if (!v) return "TBC";
    if (venueId === "venetian-prod-office") {
      return `${v.name} (${state.tbc.prodOfficeSuite || "Suite TBC"})`;
    }
    if (venueId === "venetian-content-studio") {
      return `${v.name} (${state.tbc.contentStudioSuite || "Suite TBC"})`;
    }
    return v.name;
  }

  function estimateTransit(fromId, toId) {
    if (!fromId || !toId || fromId === toId) {
      return {
        walkMin: [2, 5],
        uberMin: null,
        recommended: "indoor",
        tip: "Same venue / complex."
      };
    }
    const direct = DATA.transitLegs[`${fromId}->${toId}`];
    if (direct) return direct;
    const reverse = DATA.transitLegs[`${toId}->${fromId}`];
    if (reverse) {
      return {
        walkMin: reverse.walkMin,
        uberMin: reverse.uberMin,
        recommended: reverse.recommended,
        tip: `Return route between ${venueMap.get(fromId)?.shortName || fromId} and ${venueMap.get(toId)?.shortName || toId}. ${reverse.tip}`
      };
    }

    const vf = venueMap.get(fromId);
    const vt = venueMap.get(toId);
    if (!vf || !vt) {
      return { walkMin: [15, 22], uberMin: [12, 18], recommended: "walk", tip: "Allow buffer for resort elevators and crowds." };
    }

    if (vf.zone === "Off-Strip West" || vt.zone === "Off-Strip West" || vf.zone === "Airport" || vt.zone === "Airport") {
      return {
        walkMin: null,
        uberMin: [16, 26],
        recommended: "uber",
        tip: "Off-Strip or Airport leg. Use Uber / rideshare."
      };
    }
    if (vf.zone === vt.zone) {
      return {
        walkMin: [6, 12],
        uberMin: null,
        recommended: "indoor",
        tip: `Same resort cluster (${vf.zone}). Walk indoors with 5 min elevator/corridor buffer.`
      };
    }
    if ((vf.zone === "North Strip" && vt.zone === "Venetian / Palazzo") || (vt.zone === "North Strip" && vf.zone === "Venetian / Palazzo")) {
      return {
        walkMin: [14, 19],
        uberMin: [10, 15],
        recommended: "walk",
        tip: "Use the Sands Ave pedestrian bridge connecting Palazzo and Wynn/Encore."
      };
    }
    return {
      walkMin: [18, 26],
      uberMin: [12, 19],
      recommended: "walk",
      tip: `Cross-Strip route (${vf.zone} -> ${vt.zone}). Walking via pedestrian bridges avoids Strip rideshare gridlock.`
    };
  }

  function getActiveSchedule() {
    const base = DATA.schedule.slice();
    if (state.syncOverlay && Array.isArray(state.syncOverlay.scheduleRows)) {
      // Surface live sheet summary badge/notes without breaking structured offline timeline
      return base;
    }
    return base;
  }

  function getLeadBufferMins(event) {
    if (!event.fromVenueId || event.fromVenueId === event.venueId) {
      return event.category === "flight" ? 150 : 12;
    }
    const leg = estimateTransit(event.fromVenueId, event.venueId);
    if (leg.recommended === "uber" && leg.uberMin) {
      return leg.uberMin[1] + 10;
    }
    if (leg.walkMin) {
      return leg.walkMin[1] + 5;
    }
    return 25;
  }

  // ---------- Toast & Clipboard ----------

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${label || text}`);
    } catch {
      showToast(`${label || "Value"}: ${text}`);
    }
  }

  // ---------- Render: Header Clocks & Freshness ----------

  function updateHeaderClocks() {
    const clocks = getDualClockStrings();
    const pstEl = document.getElementById("clock-pst");
    const sydEl = document.getElementById("clock-syd");
    const simPill = document.getElementById("sim-pill");
    const freshEl = document.getElementById("sync-freshness");

    if (pstEl) pstEl.textContent = clocks.vegasText;
    if (sydEl) sydEl.textContent = clocks.sydText;
    if (simPill) simPill.hidden = !clocks.isSimulated;

    if (freshEl) {
      if (state.syncCfg.lastSyncedAt) {
        const t = new Date(state.syncCfg.lastSyncedAt);
        freshEl.textContent = `Synced ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      } else {
        freshEl.textContent = "Sheet 27 Nov";
      }
    }
  }

  // ---------- Render: View 1 - NOW ----------

  function renderNowView() {
    const container = document.getElementById("now-content");
    if (!container) return;

    const nowMs = getNowEpochMs();
    const vClock = getVegasClockParts();
    const jakeEvents = getActiveSchedule()
      .filter((e) => e.audience !== "kalen")
      .map((e) => ({
        ...e,
        startMs: vegasEpochMs(e.date, e.start),
        endMs: vegasEpochMs(e.date, e.end)
      }))
      .sort((a, b) => a.startMs - b.startMs);

    const active = jakeEvents.find((e) => nowMs >= e.startMs && nowMs < e.endMs);
    const next = jakeEvents.find((e) => e.startMs > nowMs);
    const hero = active || next || jakeEvents[jakeEvents.length - 1];

    // TBC Quick Strip
    const tbcHtml = `
      <section aria-label="Quick-Edit On-Site Details">
        <div class="tbc-grid">
          <button type="button" class="tbc-chip ${!state.tbc.prodOfficeSuite.includes("TBC") ? "is-set" : ""}" data-open-qe="qe-prod-suite">
            <span class="tbc-chip-label">Prod Office Suite</span>
            <span class="tbc-chip-val">${esc(state.tbc.prodOfficeSuite)}</span>
          </button>
          <button type="button" class="tbc-chip ${!state.tbc.contentStudioSuite.includes("TBC") ? "is-set" : ""}" data-open-qe="qe-studio-suite">
            <span class="tbc-chip-label">Content Studio</span>
            <span class="tbc-chip-val">${esc(state.tbc.contentStudioSuite)}</span>
          </button>
          <button type="button" class="tbc-chip ${!state.tbc.hotelRoom.includes("TBC") ? "is-set" : ""}" data-open-qe="qe-hotel-room">
            <span class="tbc-chip-label">HGVC Flamingo Room</span>
            <span class="tbc-chip-val">${esc(state.tbc.hotelRoom)}</span>
          </button>
          <button type="button" class="tbc-chip ${!state.tbc.satTeamDinner.includes("TBC") ? "is-set" : ""}" data-open-qe="qe-sat-dinner">
            <span class="tbc-chip-label">Sat Team Dinner</span>
            <span class="tbc-chip-val">${esc(state.tbc.satTeamDinner)}</span>
          </button>
        </div>
      </section>
    `;

    // Hero Active / Next Event
    let heroHtml = "";
    if (hero) {
      const venue = venueMap.get(hero.venueId);
      const fromId = hero.fromVenueId || "hgvc-flamingo";
      const transit = estimateTransit(fromId, hero.venueId);
      const minsToStart = Math.round((hero.startMs - nowMs) / 60000);
      const minsLeft = Math.round((hero.endMs - nowMs) / 60000);
      const leaveMins = minsToStart - getLeadBufferMins(hero);

      let statusLabel = "UP NEXT";
      let statusPill = "pill-amber";
      let countdownText = "";
      let boxClass = "";

      if (active && hero.id === active.id) {
        statusLabel = "LIVE NOW";
        statusPill = "pill-emerald";
        boxClass = "is-live";
        countdownText = `Active now - ${formatDurationMinutes(minsLeft)} remaining`;
      } else if (minsToStart > 0) {
        if (minsToStart > 1440) {
          countdownText = `Starts in ${formatDurationMinutes(minsToStart)} (${hero.date})`;
        } else if (leaveMins <= 0) {
          boxClass = "is-urgent";
          countdownText = `Leave NOW! Starts in ${formatDurationMinutes(minsToStart)}`;
        } else {
          countdownText = `Leave in ${formatDurationMinutes(leaveMins)} (starts in ${formatDurationMinutes(minsToStart)})`;
        }
      } else {
        countdownText = "Program wrapped - check Box uploads & gear return";
      }

      const transitText = transit.walkMin
        ? `Walk ${transit.walkMin[0]}-${transit.walkMin[1]}m`
        : `Uber ${transit.uberMin ? transit.uberMin[0] + "-" + transit.uberMin[1] : "15-25"}m`;

      const leadsHtml = (hero.leadContacts || [])
        .map((cid) => contactMap.get(cid))
        .filter(Boolean)
        .slice(0, 3)
        .map((c) => {
          const wa = whatsappUrl(c.phoneE164);
          return wa
            ? `<a class="action-link is-wa btn-sm" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp ${esc(c.name.split(" ")[0])}</a>`
            : `<span class="pill">${esc(c.name)}</span>`;
        })
        .join("");

      heroHtml = `
        <article class="card ${active && hero.id === active.id ? "card-live" : "card-hero"}">
          <div class="card-eyebrow">
            <span class="pill ${statusPill}">${statusLabel}</span>
            <span class="pill">${esc(formatTimeRange(hero.start, hero.end))} PST</span>
          </div>
          <h2 class="card-title">${esc(hero.title)}</h2>
          <p class="muted" style="margin:0;">
            <strong>${esc(resolveSuiteLabel(hero.venueId))}</strong>
            ${venue && venue.indoorNote ? " - " + esc(venue.indoorNote) : ""}
          </p>

          <div class="countdown-box ${boxClass}">
            <span class="countdown-main">${esc(countdownText)}</span>
            <span class="pill pill-sky">${esc(transitText)}</span>
          </div>

          <p style="margin:0.4rem 0 0; font-size:0.86rem;">${esc(hero.notes)}</p>

          <div class="btn-row">
            <a class="action-link is-maps" href="${esc(mapsGpsUrl(hero.venueId, transit.recommended === "uber" ? "driving" : "walking"))}" target="_blank" rel="noopener">
              Maps from GPS (${transit.recommended === "uber" ? "Drive" : "Walk"})
            </a>
            ${hero.fromVenueId ? `<a class="action-link" href="${esc(mapsRouteUrl(hero.fromVenueId, hero.venueId, transit.recommended === "uber" ? "driving" : "walking"))}" target="_blank" rel="noopener">Route from Prev</a>` : ""}
            ${leadsHtml}
          </div>
        </article>
      `;
    }

    // Contextual Alerts based on Vegas Date
    const alerts = [];
    if (vClock.dateStr <= "2026-11-28") {
      alerts.push({
        level: "card-hero",
        title: "Pre-Flight & LAX Transit Reminders",
        body: "Online check-in open for AA 7374 / QF11 (PNR HDHUZB / CW4SPP). Install CBP Mobile Passport Control (MPC) app before flying. Keep all batteries (4x NP-FZ100 + 1x 99Wh V-mount + 65W bank), 5-inch monitor, A7S III & lenses in cabin carry-on. Reply to Rae Hastings (+1 323-541-6551) for Sat 3:00-4:00 PM gear drop."
      });
    }
    if (vClock.dateStr === "2026-11-30") {
      alerts.push({
        level: "card-danger",
        title: "CRITICAL SENSOR WARNING: Soleia Royal Lasers (8:25 - 8:30 PM)",
        body: "Do NOT point the Sony A7S III directly toward laser beams during the 5-min Royal Lasers set on the Nightclub Stage. Shoot wide off-axis! Strict 24-hour social turnaround for the KO Party Hype Reel."
      });
    }
    if (vClock.dateStr === "2026-12-01" || vClock.dateStr === "2026-12-02") {
      alerts.push({
        level: "card-danger",
        title: "Dimly Lit Dinner Venues + Fast Turnaround Uploads",
        body: "Pack your 35mm or 50mm f/1.4 prime + run ISO 12,800 for Peter Luger (Tue) and Sushi Roku (Wed). Keep 4:5 vertical headroom on every frame."
      });
    }

    const alertsHtml = alerts
      .map((a) => `<article class="card ${a.level}"><h3 class="card-title">${esc(a.title)}</h3><p style="margin:0;font-size:0.86rem;">${esc(a.body)}</p></article>`)
      .join("");

    // Today's Remaining Run Sheet Preview
    const targetDay = DATA.days.some((d) => d.date === vClock.dateStr) ? vClock.dateStr : DATA.days[0].date;
    const dayObj = DATA.days.find((d) => d.date === targetDay);
    const todayEvents = jakeEvents.filter((e) => e.date === targetDay);
    const listHtml = todayEvents
      .map((e) => {
        const isCurrent = active && active.id === e.id;
        const isPast = nowMs > e.endMs;
        return `
          <div style="display:flex; justify-content:space-between; gap:0.5rem; padding:0.45rem 0; border-bottom:1px solid var(--border-subtle); opacity:${isPast ? "0.58" : "1"};">
            <div>
              <div style="font-size:0.78rem; font-weight:800; color:${isCurrent ? "var(--emerald-text)" : "var(--accent-text)"}; font-variant-numeric:tabular-nums;">
                ${esc(formatTimeRange(e.start, e.end))} ${isCurrent ? " (LIVE)" : ""}
              </div>
              <div style="font-weight:700; font-size:0.88rem;">${esc(e.title)}</div>
              <div class="muted" style="font-size:0.76rem;">${esc(venueMap.get(e.venueId)?.shortName || e.venueId)}</div>
            </div>
            <a class="action-link is-maps btn-sm" style="align-self:center; flex-shrink:0;" href="${esc(mapsGpsUrl(e.venueId, "walking"))}" target="_blank" rel="noopener">Map</a>
          </div>
        `;
      })
      .join("");

    // Live Sync Banner if configured & synced
    const syncNote = state.syncOverlay
      ? `<div class="card"><div class="card-eyebrow"><span class="pill pill-emerald">Live Sheet Connected</span><span class="muted">${esc(state.syncOverlay.scheduleRows?.length || 0)} synced rows</span></div><p style="margin:0;font-size:0.82rem;">Sheet last edited: ${esc(state.syncOverlay.sheetModifiedTime || "Live")}</p></div>`
      : "";

    container.innerHTML = `
      ${tbcHtml}
      ${heroHtml}
      ${alertsHtml}
      ${syncNote}
      <article class="card">
        <div class="card-eyebrow">
          <h3 class="card-title" style="margin:0;">${esc(dayObj.label)}: ${esc(dayObj.theme)}</h3>
          <button type="button" class="btn-ghost btn-sm" data-goto-day="${esc(targetDay)}">Full Day</button>
        </div>
        ${listHtml}
      </article>
      <div class="btn-row">
        <a class="action-link is-wa" href="${esc(DATA.meta.boxUploadUrl)}" target="_blank" rel="noopener">Upload Raw Footage to Box</a>
        <a class="action-link" href="${esc(DATA.meta.liveSheetUrl)}" target="_blank" rel="noopener">Open Live Tides Sheet</a>
      </div>
    `;
  }

  // ---------- Render: View 2 - SCHEDULE ----------

  function renderScheduleTabs() {
    const tablist = document.getElementById("day-tablist");
    if (!tablist) return;

    tablist.innerHTML = DATA.days
      .map((d) => {
        const selected = d.date === state.selectedDay;
        return `<button type="button" class="day-tab" role="tab" data-day="${esc(d.date)}" aria-selected="${selected}" ${selected ? "focusgroupstart" : ""}>${esc(d.short)}</button>`;
      })
      .join("");

    const activeBtn = tablist.querySelector('[aria-selected="true"]');
    if (activeBtn) {
      activeBtn.scrollIntoView({ block: "nearest", inline: "nearest", container: "nearest" });
    }
    setupScrollerHints(tablist);
  }

  function renderScheduleView() {
    renderScheduleTabs();
    const container = document.getElementById("schedule-content");
    if (!container) return;

    const dayInfo = DATA.days.find((d) => d.date === state.selectedDay) || DATA.days[0];
    let items = getActiveSchedule().filter((e) => e.date === state.selectedDay);

    if (state.audienceFilter === "jake") {
      items = items.filter((e) => e.audience !== "kalen");
    } else if (state.audienceFilter === "split") {
      items = items.filter((e) => e.audience === "kalen" || e.badges.some((b) => b.includes("Solo") || b.includes("Split")));
    }

    items.sort((a, b) => a.start.localeCompare(b.start));

    let html = `
      <div class="card" style="padding:0.7rem 0.9rem;">
        <div class="card-eyebrow" style="margin:0;">
          <strong>${esc(dayInfo.label)} - ${esc(dayInfo.theme)}</strong>
          <span class="pill">${items.length} blocks</span>
        </div>
      </div>
    `;

    let prevVenueId = null;

    items.forEach((ev) => {
      const venue = venueMap.get(ev.venueId);
      const originId = ev.fromVenueId || prevVenueId;
      if (originId && originId !== ev.venueId && ev.category !== "kalen-only") {
        const t = estimateTransit(originId, ev.venueId);
        const fromShort = venueMap.get(originId)?.shortName || originId;
        const toShort = venue?.shortName || ev.venueId;
        const walkLabel = t.walkMin ? `Walk ${t.walkMin[0]}-${t.walkMin[1]}m` : "No Walk";
        const uberLabel = t.uberMin ? `Uber ${t.uberMin[0]}-${t.uberMin[1]}m` : "Indoor";
        const gMode = t.recommended === "uber" ? "driving" : "walking";
        html += `
          <div class="transit-connector">
            <div>
              <div class="transit-stats">
                <span>${esc(fromShort)} &rarr; ${esc(toShort)}</span>
                <span class="pill pill-emerald">${esc(walkLabel)}</span>
                <span class="pill pill-sky">${esc(uberLabel)}</span>
              </div>
              <div class="muted" style="font-size:0.75rem; margin-top:0.2rem;">${esc(t.tip)}</div>
            </div>
            <div class="pill-row">
              <a class="action-link is-maps btn-sm" href="${esc(mapsRouteUrl(originId, ev.venueId, gMode))}" target="_blank" rel="noopener">Maps Route</a>
              <a class="action-link btn-sm" href="${esc(mapsGpsUrl(ev.venueId, gMode))}" target="_blank" rel="noopener">From GPS</a>
            </div>
          </div>
        `;
      }

      const badgesHtml = (ev.badges || [])
        .map((b) => {
          let cls = "pill";
          if (b.includes("Laser") || b.includes("Dim")) cls = "pill pill-danger";
          else if (b.includes("ASAP") || b.includes("24h") || b.includes("Final")) cls = "pill pill-amber";
          else if (b.includes("With Kalen") || b.includes("Flight")) cls = "pill pill-emerald";
          else if (b.includes("Split") || b.includes("Solo")) cls = "pill pill-sky";
          return `<span class="${cls}">${esc(b)}</span>`;
        })
        .join("");

      const cardClass = ev.badges?.some((b) => b.includes("Laser") || b.includes("Dim")) ? "card-danger" : "";
      const contactBtns = (ev.leadContacts || [])
        .map((cid) => contactMap.get(cid))
        .filter(Boolean)
        .map((c) => {
          const wa = whatsappUrl(c.phoneE164);
          const tel = telUrl(c.phoneE164);
          return `
            <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:0.35rem; padding:0.35rem 0; border-bottom:1px solid var(--border-subtle);">
              <div>
                <strong>${esc(c.name)}</strong>
                <span class="muted"> - ${esc(c.role)}</span>
              </div>
              <div class="pill-row">
                ${wa ? `<a class="action-link is-wa btn-sm" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
                ${tel ? `<a class="action-link btn-sm" href="${esc(tel)}">Call</a>` : ""}
              </div>
            </div>
          `;
        })
        .join("");

      const shotListHtml = ev.shotList && ev.shotList.length
        ? `<div style="margin-top:0.5rem;"><strong>Brief Shot List:</strong><ul>${ev.shotList.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
        : "";

      const showRunHtml = ev.hasKoShowRun
        ? `
          <div style="margin-top:0.65rem; overflow-x:auto;">
            <strong>Official Soleia KO Show Run (Live Sheet):</strong>
            <table class="showrun-table">
              <thead><tr><th>PST</th><th>Cue</th><th>Location / Notes</th></tr></thead>
              <tbody>
                ${DATA.koShowRun.map((r) => `
                  <tr class="${r.segment.includes("Lasers") ? "showrun-row-danger" : ""}">
                    <td style="white-space:nowrap;font-variant-numeric:tabular-nums;"><strong>${esc(r.start)}</strong>-${esc(r.finish)}</td>
                    <td><strong>${esc(r.segment)}</strong></td>
                    <td>${esc(r.location)} - ${esc(r.note)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
        : "";

      html += `
        <article class="card ${cardClass}">
          <div class="card-eyebrow">
            <span class="pill pill-amber">${esc(formatTimeRange(ev.start, ev.end))} PST</span>
            <div class="pill-row">${badgesHtml}</div>
          </div>
          <h3 class="card-title">${esc(ev.title)}</h3>
          <div class="muted" style="font-weight:700;">${esc(resolveSuiteLabel(ev.venueId))}</div>
          <p style="margin:0.35rem 0 0; font-size:0.86rem;">${esc(ev.notes)}</p>

          <details class="disclosure">
            <summary>Wayfinding, Leads${ev.shotList?.length ? ", Shot List" : ""}${ev.hasKoShowRun ? " &amp; KO Show Run" : ""}</summary>
            <div class="disclosure-body">
              <p style="margin:0 0 0.45rem;"><strong>Indoor / Access Tip:</strong> ${esc(venue?.indoorNote || "")}</p>
              <div class="btn-row" style="margin:0 0 0.55rem;">
                <a class="action-link is-maps btn-sm" href="${esc(mapsGpsUrl(ev.venueId, "walking"))}" target="_blank" rel="noopener">Google Maps (Walk)</a>
                <a class="action-link btn-sm" href="${esc(mapsGpsUrl(ev.venueId, "driving"))}" target="_blank" rel="noopener">Google Maps (Uber)</a>
              </div>
              ${contactBtns ? `<div><strong>On-Site Contacts:</strong>${contactBtns}</div>` : ""}
              ${shotListHtml}
              ${showRunHtml}
            </div>
          </details>
        </article>
      `;

      if (ev.category !== "kalen-only") {
        prevVenueId = ev.venueId;
      }
    });

    container.innerHTML = html;
  }

  // ---------- Render: View 3 - MAP ----------

  function renderMapView() {
    const container = document.getElementById("map-content");
    if (!container) return;

    const fromVenue = venueMap.get(state.mapFrom) || DATA.venues[7];
    const toVenue = venueMap.get(state.mapTo) || DATA.venues[2];
    const transit = estimateTransit(fromVenue.id, toVenue.id);

    const pinsHtml = DATA.venues
      .map((v) => {
        const isFrom = v.id === fromVenue.id;
        const isTo = v.id === toVenue.id;
        let fill = "#38bdf8";
        let r = 7;
        if (isFrom) { fill = "#10b981"; r = 9; }
        if (isTo) { fill = "#f59e0b"; r = 9; }
        if (v.alert && (v.alert.includes("SENSOR") || v.alert.includes("DIMLY")) && !isFrom && !isTo) {
          fill = "#f87171";
        }
        const anchor = v.svgX < 200 && v.id !== "meow-wolf" ? "end" : "start";
        const dx = anchor === "end" ? -11 : 11;
        return `
          <g class="svg-pin" data-pin-id="${esc(v.id)}" tabindex="0" role="button" aria-label="Select ${esc(v.shortName)}">
            <circle cx="${v.svgX}" cy="${v.svgY}" r="${r}" fill="${fill}" stroke="#090d14" stroke-width="2" />
            <text class="svg-pin-label" x="${v.svgX + dx}" y="${v.svgY + 3}" text-anchor="${anchor}">${esc(v.shortName)}</text>
          </g>
        `;
      })
      .join("");

    const fromOpts = DATA.venues.map((v) => `<option value="${esc(v.id)}" ${v.id === fromVenue.id ? "selected" : ""}>${esc(v.shortName)} (${esc(v.zone)})</option>`).join("");
    const toOpts = DATA.venues.map((v) => `<option value="${esc(v.id)}" ${v.id === toVenue.id ? "selected" : ""}>${esc(v.shortName)} (${esc(v.zone)})</option>`).join("");

    const walkStr = transit.walkMin ? `${transit.walkMin[0]}-${transit.walkMin[1]} min` : "Do Not Walk";
    const uberStr = transit.uberMin ? `${transit.uberMin[0]}-${transit.uberMin[1]} min` : "Indoor Walk";

    container.innerHTML = `
      <div class="map-layout">
        <div class="svg-map-wrap">
          <div class="card-eyebrow" style="margin-bottom:0.45rem;">
            <strong style="font-size:0.85rem;">Offline Strip Corridor Map</strong>
            <div class="pill-row">
              <span class="pill pill-emerald">Start</span>
              <span class="pill pill-amber">Dest</span>
              <span class="pill pill-danger">Dim/Laser</span>
            </div>
          </div>
          <svg class="strip-svg" viewBox="0 0 420 580" role="img" aria-label="Offline Las Vegas Strip Venue Map">
            <!-- I-15 & Strip Road Grid -->
            <line x1="78" y1="20" x2="78" y2="560" stroke="var(--border-subtle)" stroke-width="2" stroke-dasharray="4 4" />
            <text x="84" y="34" font-size="9" fill="var(--text-muted)" text-anchor="start">I-15</text>

            <!-- Las Vegas Blvd (The Strip) -->
            <line x1="205" y1="22" x2="205" y2="562" stroke="var(--accent-border)" stroke-width="6" stroke-linecap="round" />
            <text x="205" y="14" font-size="9" font-weight="800" fill="var(--accent-text)" text-anchor="middle">LAS VEGAS BLVD (NORTH &uarr;)</text>

            <!-- Cross Streets -->
            <line x1="16" y1="115" x2="404" y2="115" stroke="var(--border-subtle)" stroke-width="1.5" />
            <text x="400" y="110" font-size="8.5" fill="var(--text-muted)" text-anchor="end">Sands / Spring Mtn</text>

            <line x1="16" y1="428" x2="404" y2="428" stroke="var(--border-subtle)" stroke-width="1.5" />
            <text x="400" y="423" font-size="8.5" fill="var(--text-muted)" text-anchor="end">Flamingo Rd</text>

            <!-- Resort Zone Boxes -->
            <rect x="226" y="122" width="182" height="178" rx="10" fill="var(--accent-soft)" stroke="var(--accent-border)" stroke-width="1" />
            <text x="234" y="133" font-size="8" font-weight="800" fill="var(--accent-text)">VENETIAN / PALAZZO</text>

            <rect x="12" y="302" width="160" height="214" rx="10" fill="var(--sky-soft)" stroke="var(--sky-border)" stroke-width="1" />
            <text x="20" y="314" font-size="8" font-weight="800" fill="var(--sky-text)">CAESARS / FORUM SHOPS</text>

            <!-- Selected Route Connector Line -->
            <line x1="${fromVenue.svgX}" y1="${fromVenue.svgY}" x2="${toVenue.svgX}" y2="${toVenue.svgY}" stroke="var(--emerald)" stroke-width="2.5" stroke-dasharray="5 3" />

            ${pinsHtml}
          </svg>
          <p class="muted" style="margin:0.4rem 0 0; font-size:0.75rem;">Tap any pin on the map or pick venues on the right. Walking estimates include mega-resort elevators &amp; indoor corridors.</p>
        </div>

        <div class="view-stack">
          <article class="card">
            <h2 class="card-title">Point-to-Point Transit Calculator</h2>
            <div class="route-selectors">
              <label class="field-group">
                <span>From (Start)</span>
                <select id="map-from-select">${fromOpts}</select>
              </label>
              <label class="field-group">
                <span>To (Destination)</span>
                <select id="map-to-select">${toOpts}</select>
              </label>
            </div>
            <div class="btn-row" style="margin-top:0.5rem;">
              <button type="button" id="map-swap-btn" class="btn-secondary btn-sm">Swap A &harr; B</button>
              <button type="button" id="map-hotel-btn" class="btn-secondary btn-sm">Start from Hotel</button>
            </div>

            <div class="transit-compare-grid">
              <div class="transit-metric ${transit.recommended !== "uber" ? "is-best" : ""}">
                <div class="metric-label">Door-to-Door Walk</div>
                <div class="metric-val">${esc(walkStr)}</div>
              </div>
              <div class="transit-metric ${transit.recommended === "uber" ? "is-best" : ""}">
                <div class="metric-label">Uber / Rideshare</div>
                <div class="metric-val">${esc(uberStr)}</div>
              </div>
            </div>

            <p style="margin:0; font-size:0.86rem;"><strong>Route Playbook:</strong> ${esc(transit.tip)}</p>
          </article>

          <article class="card ${toVenue.alert && (toVenue.alert.includes("SENSOR") || toVenue.alert.includes("DIMLY")) ? "card-danger" : ""}">
            <div class="card-eyebrow">
              <span class="pill pill-amber">${esc(toVenue.zone)}</span>
              <button type="button" class="btn-ghost btn-sm" data-copy="${esc(toVenue.address)}" data-copy-label="address">Copy Address</button>
            </div>
            <h3 class="card-title">${esc(resolveSuiteLabel(toVenue.id))}</h3>
            <p class="muted" style="margin:0 0 0.4rem;">${esc(toVenue.address)}</p>
            <p style="margin:0; font-size:0.86rem;"><strong>Inside Venue:</strong> ${esc(toVenue.indoorNote)}</p>
            ${toVenue.alert ? `<p style="margin:0.45rem 0 0; font-size:0.84rem; font-weight:700; color:var(--danger);">ALERT: ${esc(toVenue.alert)}</p>` : ""}

            <div class="btn-row">
              <a class="action-link is-maps" href="${esc(mapsGpsUrl(toVenue.id, "walking"))}" target="_blank" rel="noopener">Walk from My GPS</a>
              <a class="action-link is-maps" href="${esc(mapsGpsUrl(toVenue.id, "driving"))}" target="_blank" rel="noopener">Uber/Drive from GPS</a>
              <a class="action-link" href="${esc(mapsRouteUrl(fromVenue.id, toVenue.id, transit.recommended === "uber" ? "driving" : "walking"))}" target="_blank" rel="noopener">Route From &rarr; To</a>
            </div>
          </article>
        </div>
      </div>
    `;
  }

  // ---------- Render: View 4 - CONTACTS & QUICK LINKS ----------

  function renderContactsView() {
    const container = document.getElementById("contacts-content");
    if (!container) return;

    const q = state.contactQuery.trim().toLowerCase();
    const filtered = DATA.contacts.filter((c) => {
      if (!q) return true;
      return `${c.name} ${c.role} ${c.org} ${c.notes} ${c.phoneDisplay}`.toLowerCase().includes(q);
    });

    const renderCard = (c) => {
      const wa = whatsappUrl(c.phoneE164);
      const tel = telUrl(c.phoneE164);
      const sms = smsUrl(c.phoneE164);
      return `
        <article class="contact-card">
          <div>
            <div class="card-eyebrow" style="margin-bottom:0.2rem;">
              <span class="contact-name">${esc(c.name)}</span>
              <span class="pill">${esc(c.org)}</span>
            </div>
            <div class="contact-role">${esc(c.role)}</div>
          </div>
          ${c.phoneDisplay ? `<div style="font-size:0.84rem; font-weight:700; font-variant-numeric:tabular-nums;">${esc(c.phoneDisplay)}</div>` : ""}
          ${c.email ? `<div class="muted" style="font-size:0.78rem;">${esc(c.email)}</div>` : ""}
          ${c.notes ? `<div class="muted" style="font-size:0.78rem;">${esc(c.notes)}</div>` : ""}
          <div class="btn-row" style="margin-top:auto; padding-top:0.35rem;">
            ${wa ? `<a class="action-link is-wa btn-sm" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
            ${tel ? `<a class="action-link btn-sm" href="${esc(tel)}">Call</a>` : ""}
            ${sms ? `<a class="action-link btn-sm" href="${esc(sms)}">SMS</a>` : ""}
            ${c.phoneDisplay ? `<button type="button" class="btn-ghost btn-sm" data-copy="${esc(c.phoneDisplay)}" data-copy-label="${esc(c.name)} #">Copy #</button>` : ""}
            ${c.email && !c.phoneDisplay ? `<a class="action-link btn-sm" href="mailto:${esc(c.email)}">Email</a>` : ""}
          </div>
        </article>
      `;
    };

    const pinned = filtered.filter((c) => c.group === "pinned");
    const tides = filtered.filter((c) => c.group === "tides");
    const aws = filtered.filter((c) => c.group === "aws");
    const venues = filtered.filter((c) => c.group === "venues");

    container.innerHTML = `
      <article class="card">
        <h2 class="card-title">Cloud Portals &amp; Quick Links</h2>
        <div class="quick-links-grid">
          <a class="action-link is-wa" href="${esc(DATA.meta.boxUploadUrl)}" target="_blank" rel="noopener">Upload Raw to Box</a>
          <a class="action-link is-maps" href="${esc(DATA.meta.liveSheetUrl)}" target="_blank" rel="noopener">Live Tides Sheet</a>
          <a class="action-link" href="${esc(DATA.meta.box2025RefsUrl)}" target="_blank" rel="noopener">2025 References (Box)</a>
          <a class="action-link" href="${esc(DATA.meta.studioScheduleUrl)}" target="_blank" rel="noopener">Studio Schedule (Box)</a>
          <a class="action-link" href="${esc(DATA.flights.aaManageUrl)}" target="_blank" rel="noopener">AA Check-In (HDHUZB)</a>
          <a class="action-link" href="${esc(DATA.flights.qfManageUrl)}" target="_blank" rel="noopener">Qantas (CW4SPP)</a>
        </div>
      </article>

      <div class="card" style="padding:0.7rem 0.9rem;">
        <label class="field-group">
          <span>Search Crew, AWS Clients &amp; Venues (100% On-Site WhatsApp)</span>
          <input type="search" id="contact-search-input" value="${esc(state.contactQuery)}" placeholder="Search name, role, dinner, Soleia, Venetian...">
        </label>
      </div>

      ${pinned.length ? `<h2 class="section-heading">Speed Dial (Top 10 On-Site)</h2><div class="contacts-grid">${pinned.map(renderCard).join("")}</div>` : ""}

      ${tides.length ? `
        <details class="disclosure" ${q ? "open" : ""}>
          <summary>The Tides &amp; Content Studio Team (${tides.length})</summary>
          <div class="disclosure-body"><div class="contacts-grid">${tides.map(renderCard).join("")}</div></div>
        </details>
      ` : ""}

      ${aws.length ? `
        <details class="disclosure" ${q ? "open" : ""}>
          <summary>AWS Clients &amp; Area Dinner Leads (${aws.length})</summary>
          <div class="disclosure-body"><div class="contacts-grid">${aws.map(renderCard).join("")}</div></div>
        </details>
      ` : ""}

      ${venues.length ? `
        <details class="disclosure" ${q ? "open" : ""}>
          <summary>Venues, AV &amp; Production Leads (${venues.length})</summary>
          <div class="disclosure-body"><div class="contacts-grid">${venues.map(renderCard).join("")}</div></div>
        </details>
      ` : ""}
    `;
  }

  // ---------- Render: View 5 - LOGISTICS & KIT ----------

  function renderLogisticsView() {
    const container = document.getElementById("logistics-content");
    if (!container) return;

    const f = DATA.flights;
    const h = DATA.hotel;

    const legsHtml = f.legs
      .map((l) => {
        const seat = (state.tbc.flightSeats && state.tbc.flightSeats[l.id]) || "TBC";
        const gate = (state.tbc.flightGates && state.tbc.flightGates[l.id]) || "";
        return `
          <div class="flight-leg">
            <div class="card-eyebrow">
              <strong>${esc(l.dateLabel)}: ${esc(l.route)} (${esc(l.flight)})</strong>
              <span class="pill pill-amber">${esc(l.duration)}</span>
            </div>
            <div style="font-weight:700; font-size:0.88rem;">${esc(l.depTime)} &rarr; ${esc(l.arrTime)}</div>
            <div class="muted" style="font-size:0.78rem;">${esc(l.operatedBy)} &middot; ${esc(l.terminal)} &middot; ${esc(l.cabin)}</div>
            <div class="pill-row" style="margin-top:0.4rem;">
              <button type="button" class="btn-ghost btn-sm" data-open-qe="qe-seat-${esc(l.id.replace("AA", ""))}">Seat: ${esc(seat)}</button>
              ${gate ? `<span class="pill pill-emerald">Gate: ${esc(gate)}</span>` : ""}
            </div>
            ${l.layoverAfter ? `<div class="pill pill-sky" style="margin-top:0.45rem;">${esc(l.layoverAfter)}</div>` : ""}
          </div>
        `;
      })
      .join("");

    container.innerHTML = `
      <article class="card card-hero">
        <div class="card-eyebrow">
          <h2 class="card-title" style="margin:0;">Flights &amp; Booking Codes</h2>
          <span class="pill pill-emerald">Confirmed</span>
        </div>
        <div class="pill-row">
          <button type="button" class="btn-secondary btn-sm" data-copy="${esc(f.aaPnr)}" data-copy-label="AA PNR">AA PNR: ${esc(f.aaPnr)}</button>
          <button type="button" class="btn-secondary btn-sm" data-copy="${esc(f.qfPnr)}" data-copy-label="Qantas PNR">QF PNR: ${esc(f.qfPnr)}</button>
          <button type="button" class="btn-secondary btn-sm" data-copy="${esc(f.eTicket)}" data-copy-label="E-Ticket">Ticket: ${esc(f.eTicket)}</button>
        </div>
        ${legsHtml}
        <details class="disclosure">
          <summary>LAX Transit Playbook (3h19m Outbound / 4h10m Return)</summary>
          <div class="disclosure-body">
            <ul>${f.laxPlaybook.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
          </div>
        </details>
      </article>

      <article class="card">
        <div class="card-eyebrow">
          <h2 class="card-title" style="margin:0;">Hotel &amp; Clearances</h2>
          <button type="button" class="btn-ghost btn-sm" data-open-qe="qe-hotel-room">Room: ${esc(state.tbc.hotelRoom)}</button>
        </div>
        <p style="margin:0 0 0.45rem;"><strong>${esc(h.name)}</strong><br><span class="muted">${esc(h.address)}</span></p>
        <div class="pill-row" style="margin-bottom:0.65rem;">
          <button type="button" class="btn-secondary btn-sm" data-copy="${esc(h.confirmation)}" data-copy-label="Hotel Conf #">Conf #${esc(h.confirmation)}</button>
          <span class="pill">${esc(h.checkIn)} - ${esc(h.checkOut)}</span>
          <a class="action-link is-maps btn-sm" href="${esc(mapsGpsUrl("hgvc-flamingo", "driving"))}" target="_blank" rel="noopener">Hotel Maps</a>
        </div>
        <div class="kv-list">
          ${DATA.admin.map((a) => `
            <div class="kv-item">
              <div class="kv-k">${esc(a.label)}</div>
              <div class="kv-v">${esc(a.value)}</div>
            </div>
          `).join("")}
        </div>
      </article>

      <article class="card">
        <h2 class="card-title">Gear Kit &amp; Field Technical Spec</h2>

        <details class="disclosure" open>
          <summary>Confirmed Track B Rental (Jack Fox Media / Rae Hastings)</summary>
          <div class="disclosure-body">
            <p style="margin:0 0 0.35rem;"><strong>${esc(DATA.gear.localRental.supplier)}</strong><br>${esc(DATA.gear.localRental.estCost)}<br>${esc(DATA.gear.localRental.handover)}</p>
            <ul>${DATA.gear.localRental.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
          </div>
        </details>

        <details class="disclosure">
          <summary>Carry-On Core Kit (Cabin Only - Zero Checked Gear)</summary>
          <div class="disclosure-body">
            <ul>${DATA.gear.carryOn.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
          </div>
        </details>

        <details class="disclosure">
          <summary>Camera, Framing (16:9 + 4:5), Audio &amp; Box Specs</summary>
          <div class="disclosure-body">
            <div class="kv-list" style="margin-top:0.4rem;">
              ${DATA.cameraSpecs.map((s) => `
                <div class="kv-item">
                  <div class="kv-k">${esc(s.label)}</div>
                  <div class="kv-v">${esc(s.value)}</div>
                </div>
              `).join("")}
            </div>
          </div>
        </details>

        <details class="disclosure">
          <summary>APJ Delegate Vox-Pop Question Bank (9 Prompts)</summary>
          <div class="disclosure-body">
            <ul>${DATA.voxPopQuestions.map((v) => `<li><strong>${esc(v.group)}:</strong> "${esc(v.q)}"</li>`).join("")}</ul>
          </div>
        </details>
      </article>
    `;
  }

  // ---------- View Switching & Navigation ----------

  function switchView(viewName) {
    state.view = viewName;
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      if (btn.dataset.view === viewName) {
        btn.setAttribute("aria-current", "page");
      } else {
        btn.removeAttribute("aria-current");
      }
    });
    document.querySelectorAll(".view-panel").forEach((panel) => {
      panel.hidden = panel.id !== `view-${viewName}`;
    });
    renderActiveView();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function renderActiveView() {
    if (state.view === "now") renderNowView();
    else if (state.view === "schedule") renderScheduleView();
    else if (state.view === "map") renderMapView();
    else if (state.view === "contacts") renderContactsView();
    else if (state.view === "logistics") renderLogisticsView();
  }

  // ---------- Theme Toggle ----------

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "dark" || theme === "light") {
      root.setAttribute("data-theme", theme);
    } else {
      root.removeAttribute("data-theme");
    }
    const label = document.getElementById("theme-btn-text");
    if (label) {
      label.textContent = theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto";
    }
  }

  function toggleTheme() {
    const cur = localStorage.getItem(STORAGE_KEYS.theme) || "auto";
    const next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
    if (next === "auto") localStorage.removeItem(STORAGE_KEYS.theme);
    else localStorage.setItem(STORAGE_KEYS.theme, next);
    applyTheme(next);
    showToast(`Theme: ${next.toUpperCase()}`);
  }

  // ---------- Native Dialog Helpers (Modern Web Guidance + Safari closedby Fallback) ----------

  function installDialogLightDismissFallback() {
    if ("closedBy" in HTMLDialogElement.prototype) return;
    const outside = (e, dlg) => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    document.querySelectorAll('dialog[closedby="any"]').forEach((dlg) => {
      let pressedOut = false;
      dlg.addEventListener("pointerdown", (e) => { pressedOut = outside(e, dlg); });
      dlg.addEventListener("pointerup", (e) => {
        if (pressedOut && outside(e, dlg)) dlg.close();
      });
    });
  }

  function openQuickEdit(focusFieldId) {
    const dlg = document.getElementById("quick-edit-dialog");
    if (!dlg) return;

    document.getElementById("qe-prod-suite").value = state.tbc.prodOfficeSuite || "";
    document.getElementById("qe-studio-suite").value = state.tbc.contentStudioSuite || "";
    document.getElementById("qe-hotel-room").value = state.tbc.hotelRoom || "";
    document.getElementById("qe-sat-dinner").value = state.tbc.satTeamDinner || "";
    document.getElementById("qe-seat-7374").value = state.tbc.flightSeats?.AA7374 || "";
    document.getElementById("qe-gate-7374").value = state.tbc.flightGates?.AA7374 || "";
    document.getElementById("qe-seat-6425").value = state.tbc.flightSeats?.AA6425 || "";
    document.getElementById("qe-gate-6425").value = state.tbc.flightGates?.AA6425 || "";
    document.getElementById("qe-seat-421").value = state.tbc.flightSeats?.AA421 || "";
    document.getElementById("qe-seat-7387").value = state.tbc.flightSeats?.AA7387 || "";
    document.getElementById("qe-notes").value = state.tbc.notes || "";

    dlg.showModal();
    if (focusFieldId) {
      const target = document.getElementById(focusFieldId);
      if (target) target.focus();
    }
  }

  function openSettingsDialog() {
    const dlg = document.getElementById("settings-dialog");
    if (!dlg) return;
    document.getElementById("sync-url-input").value = state.syncCfg.url || "";
    document.getElementById("sync-token-input").value = state.syncCfg.token || DATA.meta.defaultSyncSecret || "";
    document.getElementById("sim-custom-input").value = state.simIso || "";
    document.querySelectorAll(".sim-preset-btn").forEach((b) => {
      b.classList.toggle("is-active", (b.dataset.sim || "") === (state.simIso || ""));
    });
    dlg.showModal();
  }

  // ---------- Live Tides Google Sheet Sync ----------

  async function runLiveSheetSync() {
    const url = (state.syncCfg.url || "").trim();
    const token = (state.syncCfg.token || "").trim();
    if (!url) {
      showToast("Offline snapshot active - add Apps Script URL in Setup for live Vegas refreshes.");
      openSettingsDialog();
      return;
    }

    showToast("Syncing live Tides Sheet...");
    try {
      const sep = url.includes("?") ? "&" : "?";
      const res = await fetch(`${url}${sep}token=${encodeURIComponent(token)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Sync rejected");

      state.syncOverlay = json;
      state.syncCfg.lastSyncedAt = new Date().toISOString();
      saveJson(STORAGE_KEYS.syncOverlay, state.syncOverlay);
      saveJson(STORAGE_KEYS.syncCfg, state.syncCfg);
      updateHeaderClocks();
      renderActiveView();
      showToast(`Live Sheet synced (${json.scheduleRows?.length || 0} rows updated)`);
    } catch (err) {
      showToast(`Sync skipped (offline or URL error): ${err.message}`);
    }
  }

  // ---------- Scroller Edge Fade Fallback (IntersectionObserver) ----------

  function setupScrollerHints(scroller) {
    if (!scroller || CSS.supports("animation-timeline", "scroll()")) return;
    const first = scroller.firstElementChild;
    const last = scroller.lastElementChild;
    if (!first || !last) return;
    const obs = new IntersectionObserver((entries) => {
      for (const { target, intersectionRatio } of entries) {
        scroller.classList.toggle(target === first ? "more-start" : "more-end", intersectionRatio < 1);
      }
    }, { root: scroller, threshold: 1, rootMargin: "1px" });
    obs.observe(first);
    obs.observe(last);
  }

  // ---------- Event Delegation ----------

  function bindEvents() {
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    document.getElementById("sync-btn")?.addEventListener("click", runLiveSheetSync);
    document.getElementById("quick-edit-btn")?.addEventListener("click", () => openQuickEdit());
    document.getElementById("settings-btn")?.addEventListener("click", openSettingsDialog);
    document.getElementById("theme-toggle-btn")?.addEventListener("click", toggleTheme);

    // Quick-Edit Form Submit & Reset
    document.getElementById("quick-edit-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      state.tbc = {
        prodOfficeSuite: document.getElementById("qe-prod-suite").value.trim() || DATA.tbcDefaults.prodOfficeSuite,
        contentStudioSuite: document.getElementById("qe-studio-suite").value.trim() || DATA.tbcDefaults.contentStudioSuite,
        hotelRoom: document.getElementById("qe-hotel-room").value.trim() || DATA.tbcDefaults.hotelRoom,
        satTeamDinner: document.getElementById("qe-sat-dinner").value.trim() || DATA.tbcDefaults.satTeamDinner,
        flightSeats: {
          AA7374: document.getElementById("qe-seat-7374").value.trim() || "TBC",
          AA6425: document.getElementById("qe-seat-6425").value.trim() || "TBC",
          AA421: document.getElementById("qe-seat-421").value.trim() || "TBC",
          AA7387: document.getElementById("qe-seat-7387").value.trim() || "TBC"
        },
        flightGates: {
          AA7374: document.getElementById("qe-gate-7374").value.trim(),
          AA6425: document.getElementById("qe-gate-6425").value.trim(),
          AA421: state.tbc.flightGates?.AA421 || "",
          AA7387: state.tbc.flightGates?.AA7387 || ""
        },
        notes: document.getElementById("qe-notes").value.trim()
      };
      saveJson(STORAGE_KEYS.tbc, state.tbc);
      document.getElementById("quick-edit-dialog").close();
      renderActiveView();
      showToast("Saved on-site details to device");
    });

    document.getElementById("qe-reset-btn")?.addEventListener("click", () => {
      state.tbc = structuredCloneFallback(DATA.tbcDefaults);
      localStorage.removeItem(STORAGE_KEYS.tbc);
      document.getElementById("quick-edit-dialog").close();
      renderActiveView();
      showToast("Reset to default TBC values");
    });

    // Settings Dialog Actions
    document.querySelectorAll(".sim-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.sim || "";
        state.simIso = val;
        if (val) localStorage.setItem(STORAGE_KEYS.simIso, val);
        else localStorage.removeItem(STORAGE_KEYS.simIso);
        document.getElementById("sim-custom-input").value = val;
        document.querySelectorAll(".sim-preset-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
        updateHeaderClocks();
        renderActiveView();
        showToast(val ? `Simulating ${val.replace("T", " ")} PST` : "Live Vegas PST active");
      });
    });

    document.getElementById("sim-custom-input")?.addEventListener("change", (e) => {
      const val = e.target.value;
      state.simIso = val;
      if (val) localStorage.setItem(STORAGE_KEYS.simIso, val);
      else localStorage.removeItem(STORAGE_KEYS.simIso);
      updateHeaderClocks();
      renderActiveView();
    });

    document.getElementById("save-sync-btn")?.addEventListener("click", () => {
      state.syncCfg.url = document.getElementById("sync-url-input").value.trim();
      state.syncCfg.token = document.getElementById("sync-token-input").value.trim();
      saveJson(STORAGE_KEYS.syncCfg, state.syncCfg);
      document.getElementById("settings-dialog").close();
      if (state.syncCfg.url) runLiveSheetSync();
      else showToast("Sync settings saved");
    });

    document.getElementById("clear-sync-btn")?.addEventListener("click", () => {
      state.syncOverlay = null;
      state.syncCfg.lastSyncedAt = "";
      localStorage.removeItem(STORAGE_KEYS.syncOverlay);
      saveJson(STORAGE_KEYS.syncCfg, state.syncCfg);
      updateHeaderClocks();
      renderActiveView();
      showToast("Cleared synced overlay; using baked snapshot");
    });

    // Reset dialog.returnValue cleanly per modern-web-guidance
    document.querySelectorAll("dialog").forEach((dlg) => {
      dlg.addEventListener("close", () => { dlg.returnValue = ""; });
    });

    // Dynamic Content Delegation inside <main>
    const main = document.getElementById("app-main");
    main.addEventListener("click", (e) => {
      const target = e.target;

      const copyBtn = target.closest("[data-copy]");
      if (copyBtn) {
        copyText(copyBtn.dataset.copy, copyBtn.dataset.copyLabel);
        return;
      }

      const qeBtn = target.closest("[data-open-qe]");
      if (qeBtn) {
        openQuickEdit(qeBtn.dataset.openQe);
        return;
      }

      const gotoDayBtn = target.closest("[data-goto-day]");
      if (gotoDayBtn) {
        state.selectedDay = gotoDayBtn.dataset.gotoDay;
        switchView("schedule");
        return;
      }

      const dayTab = target.closest(".day-tab");
      if (dayTab) {
        state.selectedDay = dayTab.dataset.day;
        renderScheduleView();
        return;
      }

      const filterBtn = target.closest(".filter-pill");
      if (filterBtn) {
        state.audienceFilter = filterBtn.dataset.audience;
        document.querySelectorAll(".filter-pill").forEach((b) => {
          const active = b === filterBtn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", String(active));
        });
        renderScheduleView();
        return;
      }

      const pin = target.closest("[data-pin-id]");
      if (pin) {
        const pid = pin.dataset.pinId;
        if (state.mapNextSlot === "to") {
          state.mapTo = pid;
          state.mapNextSlot = "from";
        } else {
          state.mapFrom = pid;
          state.mapNextSlot = "to";
        }
        renderMapView();
        return;
      }

      if (target.id === "map-swap-btn") {
        const tmp = state.mapFrom;
        state.mapFrom = state.mapTo;
        state.mapTo = tmp;
        renderMapView();
        return;
      }

      if (target.id === "map-hotel-btn") {
        state.mapFrom = "hgvc-flamingo";
        renderMapView();
      }
    });

    main.addEventListener("change", (e) => {
      if (e.target.id === "map-from-select") {
        state.mapFrom = e.target.value;
        renderMapView();
      } else if (e.target.id === "map-to-select") {
        state.mapTo = e.target.value;
        renderMapView();
      }
    });

    main.addEventListener("input", (e) => {
      if (e.target.id === "contact-search-input") {
        state.contactQuery = e.target.value;
        const pos = e.target.selectionStart;
        renderContactsView();
        const freshInput = document.getElementById("contact-search-input");
        if (freshInput) {
          freshInput.focus();
          freshInput.setSelectionRange(pos, pos);
        }
      }
    });
  }

  // ---------- Init ----------

  function init() {
    applyTheme(localStorage.getItem(STORAGE_KEYS.theme) || "auto");
    installDialogLightDismissFallback();

    // Auto-select current Vegas day if within trip window
    const vClock = getVegasClockParts();
    if (DATA.days.some((d) => d.date === vClock.dateStr)) {
      state.selectedDay = vClock.dateStr;
    }

    bindEvents();
    updateHeaderClocks();
    renderActiveView();
    setInterval(updateHeaderClocks, 15000);

    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        // Silent fallback if SW blocked
      });
    }
  }

  init();
})();
