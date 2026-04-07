import "./styles.css";
import {
  getMissionState,
  formatMET,
  formatCountdown,
  LAUNCH,
  SPLASH,
  type MissionState,
} from "./mission.ts";
import { createOrbitScene, type OrbitLoadCallbacks } from "./orbit-scene.ts";
import { initI18n, t, setLocale, getLocale, getLocales, onLocaleChange } from "./i18n.ts";
import { getTelemetry } from "./ephemeris.ts";
import { createSpeedChart, createDistanceChart, createAltitudeChart, createMoonDistanceChart, createRadialRateChart, type MissionChart } from "./telemetry-charts.ts";

/* ══════════════════════════════════════════════
   i18n bootstrap + locale picker
   ══════════════════════════════════════════════ */
initI18n();

{
  const picker = document.getElementById("locale-picker");
  if (picker) {
    const locales = getLocales();

    // ── Button (pill) ──────────────────────────────────────────────
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "locale-picker__btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Language");

    const flagSpan = document.createElement("span");
    flagSpan.className = "locale-picker__flag";
    const codeSpan = document.createElement("span");
    codeSpan.className = "locale-picker__code";
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("viewBox", "0 0 10 6");
    chevron.setAttribute("fill", "none");
    chevron.classList.add("locale-picker__chevron");
    chevron.innerHTML = `<path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    btn.appendChild(flagSpan);
    btn.appendChild(codeSpan);
    btn.appendChild(chevron);

    // ── Dropdown menu ─────────────────────────────────────────────
    const menu = document.createElement("div");
    menu.className = "locale-picker__menu";
    menu.setAttribute("role", "listbox");

    function updateBtn(code: string) {
      const loc = locales.find(l => l.code === code) ?? locales[0];
      flagSpan.textContent = loc.flag ?? "";
      codeSpan.textContent = code.toUpperCase();
      menu.querySelectorAll<HTMLButtonElement>(".locale-picker__option").forEach(o => {
        o.setAttribute("aria-selected", o.dataset.code === code ? "true" : "false");
      });
    }

    for (const { code, name, flag } of locales) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "locale-picker__option";
      opt.dataset.code = code;
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", code === getLocale() ? "true" : "false");
      const fSpan = document.createElement("span");
      fSpan.className = "locale-picker__option-flag";
      fSpan.textContent = flag ?? "";
      const nSpan = document.createElement("span");
      nSpan.className = "locale-picker__option-name";
      nSpan.textContent = name;
      opt.appendChild(fSpan);
      opt.appendChild(nSpan);
      // Use pointerdown so selection fires before the outside-click handler
      opt.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        setLocale(code);
        menu.removeAttribute("data-open");
        btn.setAttribute("aria-expanded", "false");
      });
      menu.appendChild(opt);
    }

    updateBtn(getLocale());

    // Position menu using fixed coords so it escapes dashboard overflow:hidden
    function positionMenu() {
      const r = btn.getBoundingClientRect();
      const menuH = menu.offsetHeight || 300;
      const spaceBelow = window.innerHeight - r.bottom;
      if (spaceBelow >= menuH + 8 || spaceBelow > r.top) {
        // Open downward
        menu.style.top  = `${r.bottom + 6}px`;
        menu.style.bottom = "";
      } else {
        // Open upward
        menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
        menu.style.top = "";
      }
      menu.style.right = `${window.innerWidth - r.right}px`;
    }

    // Stop pointer events inside menu and button from bubbling to document close handler
    menu.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());

    // Toggle open/close
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = menu.hasAttribute("data-open");
      if (isOpen) {
        menu.removeAttribute("data-open");
        btn.setAttribute("aria-expanded", "false");
      } else {
        menu.setAttribute("data-open", "");
        btn.setAttribute("aria-expanded", "true");
        positionMenu();
      }
    });
    document.addEventListener("pointerdown", () => {
      menu.removeAttribute("data-open");
      btn.setAttribute("aria-expanded", "false");
    });

    // Append menu to body so it's never clipped by any ancestor overflow
    picker.appendChild(btn);
    document.body.appendChild(menu);
    onLocaleChange(updateBtn);
  }
}

/* ══════════════════════════════════════════════
   DOM elements
   ══════════════════════════════════════════════ */
const topbarStatus   = document.getElementById("mission-hud-phase");
const topbarMet      = document.getElementById("mission-hud-met");
const subLabel       = document.getElementById("mission-hud-sub-label");
const subValue       = document.getElementById("mission-hud-sub-value");
const telSpeed       = document.getElementById("tel-speed");
const telDistance    = document.getElementById("tel-distance");
const telAltitude    = document.getElementById("tel-altitude");
const telDistMoon    = document.getElementById("tel-dist-moon");
const orbitPhaseLabel = document.getElementById("orbit-phase-label");
const timelineNow    = document.getElementById("timeline-now");
const timelineNowLabel = document.getElementById("timeline-now-label");

const timelineRows = [...document.querySelectorAll<HTMLElement>(".timeline-row")];
const sortedRows: Array<{ el: HTMLElement; h: number }> = timelineRows
  .map((el) => ({ el, h: parseFloat(el.dataset.metHours ?? "") }))
  .filter((x) => Number.isFinite(x.h))
  .sort((a, b) => a.h - b.h);

const TOTAL_MET_HOURS = (SPLASH.getTime() - LAUNCH.getTime()) / 3600000;

const timelineTrack = document.querySelector<HTMLElement>(".timeline-track");
const timelineTrackLine = document.querySelector<HTMLElement>(".timeline-track__line");
const timelineList  = document.getElementById("timeline");

let lastTrackHeight = 0;
let lastNowPx = -1;

function syncTrackHeight(): void {
  if (!timelineTrack || !timelineList) return;
  const h = timelineList.scrollHeight;
  if (h !== lastTrackHeight) {
    timelineTrack.style.height = `${h}px`;
    lastTrackHeight = h;
  }
}

/* ══════════════════════════════════════════════
   Inject local times into timeline rows
   ══════════════════════════════════════════════ */
function buildLocalTimeFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZoneName: "short",
  });
}

let localFmt = buildLocalTimeFormatter();

function injectLocalTimes(): void {
  for (const row of timelineRows) {
    const metH = parseFloat(row.dataset.metHours ?? "");
    if (!Number.isFinite(metH)) continue;

    const eventDate = new Date(LAUNCH.getTime() + metH * 3600000);
    const localStr = localFmt.format(eventDate);

    const metSpan = row.querySelector(".event__met");
    if (!metSpan) continue;

    let wrapper = metSpan.parentElement;
    if (!wrapper?.classList.contains("event__times")) {
      wrapper = document.createElement("span");
      wrapper.className = "event__times";
      metSpan.parentElement!.insertBefore(wrapper, metSpan);
      wrapper.appendChild(metSpan);
    }

    let localSpan = wrapper.querySelector(".event__local") as HTMLElement | null;
    if (!localSpan) {
      localSpan = document.createElement("span");
      localSpan.className = "event__local";
      wrapper.appendChild(localSpan);
    }
    localSpan.textContent = localStr;
  }
}

injectLocalTimes();

/* ══════════════════════════════════════════════
   Resizable side panel
   ══════════════════════════════════════════════ */
{
  const gutter = document.getElementById("resize-gutter");
  const root = document.documentElement;

  if (gutter) {
    let dragging = false;

    gutter.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      gutter.classList.add("resize-gutter--active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const sideW = window.innerWidth - e.clientX - 4;
      const clamped = Math.max(200, Math.min(sideW, window.innerWidth * 0.6));
      root.style.setProperty("--side-w", `${clamped}px`);
      orbitApi?.resize();
      syncTrackHeight();
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      gutter.classList.remove("resize-gutter--active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      updateDashboard();
    });
  }
}

/* ══════════════════════════════════════════════
   Phase name lookup
   ══════════════════════════════════════════════ */
function getPhaseName(metHours: number): string {
  if (metHours < 3.4)    return t("phase.liftoff.title");
  if (metHours < 25.617) return t("phase.heo.title");
  if (metHours < 103.983) return t("phase.tl.title");
  if (metHours < 139.78) return t("phase.lunar.title");
  if (metHours < 211)    return t("phase.te.title");
  return t("phase.edl.title");
}

/* ══════════════════════════════════════════════
   Timeline "now" indicator position
   ══════════════════════════════════════════════ */
function rowMidY(el: HTMLElement): number {
  return el.offsetTop + el.offsetHeight / 2;
}

function computeNowPx(state: MissionState): number {
  if (sortedRows.length === 0) return 0;
  if (state.phase === "pre") return sortedRows[0].el.offsetTop;
  if (state.phase === "complete") {
    const last = sortedRows[sortedRows.length - 1];
    return rowMidY(last.el);
  }
  const mh = state.metHours;
  if (mh <= sortedRows[0].h) return rowMidY(sortedRows[0].el);
  const last = sortedRows[sortedRows.length - 1];
  if (mh >= last.h) return rowMidY(last.el);
  for (let i = 0; i < sortedRows.length - 1; i++) {
    const a = sortedRows[i];
    const b = sortedRows[i + 1];
    if (mh >= a.h && mh < b.h) {
      const t2 = (mh - a.h) / (b.h - a.h);
      return rowMidY(a.el) + t2 * (rowMidY(b.el) - rowMidY(a.el));
    }
  }
  return rowMidY(last.el);
}

/* ══════════════════════════════════════════════
   Charts
   ══════════════════════════════════════════════ */
let speedChart:      MissionChart | null = null;
let distChart:       MissionChart | null = null;
let altChart:        MissionChart | null = null;
let moonDistChart:   MissionChart | null = null;
let radialRateChart: MissionChart | null = null;

const speedCanvas      = document.getElementById("chart-speed")         as HTMLCanvasElement | null;
const distCanvas       = document.getElementById("chart-distance")      as HTMLCanvasElement | null;
const altCanvas        = document.getElementById("chart-altitude")      as HTMLCanvasElement | null;
const moonDistCanvas   = document.getElementById("chart-moon-distance") as HTMLCanvasElement | null;
const radialRateCanvas = document.getElementById("chart-radial-rate")   as HTMLCanvasElement | null;

if (speedCanvas)      { try { speedChart      = createSpeedChart(speedCanvas);           } catch (e) { console.warn("Speed chart:", e); } }
if (distCanvas)       { try { distChart       = createDistanceChart(distCanvas);         } catch (e) { console.warn("Distance chart:", e); } }
if (altCanvas)        { try { altChart        = createAltitudeChart(altCanvas);          } catch (e) { console.warn("Altitude chart:", e); } }
if (moonDistCanvas)   { try { moonDistChart   = createMoonDistanceChart(moonDistCanvas); } catch (e) { console.warn("Moon dist chart:", e); } }
if (radialRateCanvas) { try { radialRateChart = createRadialRateChart(radialRateCanvas); } catch (e) { console.warn("Radial rate chart:", e); } }


/* ══════════════════════════════════════════════
   Timeline panel resize gutter
   ══════════════════════════════════════════════ */
{
  const tGutter = document.getElementById("timeline-resize-gutter");
  const root = document.documentElement;

  if (tGutter) {
    let dragging = false;

    tGutter.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      tGutter.classList.add("timeline-resize-gutter--active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      // timeline-panel starts at x=0, gutter is right after it
      const w = Math.max(140, Math.min(e.clientX - 2, window.innerWidth * 0.35));
      root.style.setProperty("--timeline-w", `${w}px`);
      orbitApi?.resize();
      syncTrackHeight();
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      tGutter.classList.remove("timeline-resize-gutter--active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }
}

/* ══════════════════════════════════════════════
   Global tooltip popup (avoids overflow clipping)
   ══════════════════════════════════════════════ */
{
  const popup = document.getElementById("tip-popup") as HTMLElement | null;
  if (popup) {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    document.addEventListener("mouseover", (e) => {
      const badge = (e.target as HTMLElement).closest<HTMLElement>(".telem-tip");
      if (!badge || !popup) return;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

      popup.textContent = badge.dataset.tip ?? "";
      popup.style.display = "block";

      requestAnimationFrame(() => {
        const bRect  = badge.getBoundingClientRect();
        const pw     = popup.offsetWidth;
        const ph     = popup.offsetHeight;
        const margin = 8;

        // Center tooltip above badge, clamp to viewport edges
        let left = bRect.left + bRect.width / 2 - pw / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));

        let top = bRect.top - ph - 10;
        // Flip below if not enough room above
        if (top < margin) top = bRect.bottom + 8;

        // Arrow position relative to popup left edge
        const arrowLeft = Math.max(10, Math.min(
          bRect.left + bRect.width / 2 - left,
          pw - 10
        ));
        popup.style.setProperty("--arrow-left", `${arrowLeft}px`);
        popup.style.left = `${left}px`;
        popup.style.top  = `${top}px`;
      });
    });

    document.addEventListener("mouseout", (e) => {
      const badge = (e.target as HTMLElement).closest<HTMLElement>(".telem-tip");
      if (!badge || !popup) return;
      hideTimer = setTimeout(() => { popup.style.display = "none"; }, 80);
    });

    // Touch support — tap badge to show, tap anywhere else to hide
    document.addEventListener("touchstart", (e) => {
      const badge = (e.target as HTMLElement).closest<HTMLElement>(".telem-tip");
      if (!badge) {
        popup.style.display = "none";
        return;
      }
      e.preventDefault();
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      popup.textContent = badge.dataset.tip ?? "";
      popup.style.display = "block";
      requestAnimationFrame(() => {
        const bRect = badge.getBoundingClientRect();
        const pw    = popup.offsetWidth;
        const ph    = popup.offsetHeight;
        const margin = 8;
        let left = bRect.left + bRect.width / 2 - pw / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
        let top = bRect.top - ph - 10;
        if (top < margin) top = bRect.bottom + 8;
        const arrowLeft = Math.max(10, Math.min(bRect.left + bRect.width / 2 - left, pw - 10));
        popup.style.setProperty("--arrow-left", `${arrowLeft}px`);
        popup.style.left = `${left}px`;
        popup.style.top  = `${top}px`;
      });
    }, { passive: false });
  }
}

/* ══════════════════════════════════════════════
   Main update loop
   ══════════════════════════════════════════════ */
const scrollEl = document.querySelector(".timeline-scroll");
let userScrolledAt = 0;
let lastCurrentRow: HTMLElement | undefined;
const SCROLL_PAUSE_MS = 15_000;
const mobileQuery = window.matchMedia("(max-width: 680px)");

if (scrollEl) {
  scrollEl.addEventListener("wheel", () => { userScrolledAt = Date.now(); }, { passive: true });
  scrollEl.addEventListener("touchmove", () => { userScrolledAt = Date.now(); }, { passive: true });
  scrollEl.addEventListener("pointerdown", () => { userScrolledAt = Date.now(); });
}

/* ══════════════════════════════════════════════
   Mobile layout: move footer into sidebar scroll
   ══════════════════════════════════════════════ */
{
  const dashboard = document.querySelector<HTMLElement>(".dashboard");
  const sidePanel = document.querySelector<HTMLElement>(".side-panel");
  const statusBar = document.querySelector<HTMLElement>(".status-bar");

  function applyMobileLayout(): void {
    if (!dashboard || !sidePanel || !statusBar) return;
    if (mobileQuery.matches) {
      sidePanel.appendChild(statusBar);
    } else {
      dashboard.appendChild(statusBar);
    }
  }

  applyMobileLayout();
  mobileQuery.addEventListener("change", applyMobileLayout);
}

function updateDashboard() {
  const state = getMissionState();
  const metHours = state.phase === "pre"      ? 0
                 : state.phase === "complete" ? TOTAL_MET_HOURS
                 : state.metHours;

  // ── Top bar ──
  if (topbarStatus) {
    if (state.phase === "pre")      topbarStatus.textContent = t("hud.preLaunch");
    else if (state.phase === "complete") topbarStatus.textContent = t("hud.missionComplete");
    else topbarStatus.textContent = t("hud.inFlight");
  }

  if (topbarMet) {
    if (state.phase === "pre")      topbarMet.textContent = "00/00:00:00";
    else if (state.phase === "complete") topbarMet.textContent = formatMET(TOTAL_MET_HOURS);
    else topbarMet.textContent = state.metLabel;
  }

  if (subLabel && subValue) {
    if (state.phase === "pre") {
      subLabel.textContent = t("hud.timeToLaunch");
      subValue.textContent = formatCountdown(state.toLaunchMs);
    } else if (state.phase === "complete") {
      subLabel.textContent = t("hud.splashdown");
      subValue.textContent = SPLASH.toLocaleDateString();
    } else {
      subLabel.textContent = t("hud.timeToSplashdown");
      subValue.textContent = formatCountdown(state.remainingMs);
    }
  }

  // ── Telemetry (from real ephemeris data) ──
  const utcMs = LAUNCH.getTime() + metHours * 3600000;
  const tel = getTelemetry(utcMs);

  if (telSpeed)    telSpeed.textContent    = tel.speed.toFixed(2);
  if (telDistance) telDistance.textContent = Math.round(tel.distanceFromEarth).toLocaleString();
  if (telAltitude) telAltitude.textContent = Math.round(tel.altitude).toLocaleString();
  if (telDistMoon) telDistMoon.textContent = Math.round(tel.distanceFromMoon).toLocaleString();
  const altBody = document.getElementById("tel-altitude-body");
  if (altBody) altBody.textContent = tel.altitudeBody === "moon" ? "☽" : "⊕";

  // ── Orbit phase label ──
  if (orbitPhaseLabel && state.phase === "flight") {
    orbitPhaseLabel.textContent = getPhaseName(metHours);
  }

  // ── Chart needles ──
  speedChart?.setNeedle(metHours);
  distChart?.setNeedle(metHours);
  altChart?.setNeedle(metHours);
  moonDistChart?.setNeedle(metHours);
  radialRateChart?.setNeedle(metHours);

  // ── Timeline marker (only write DOM when the value actually changes) ──
  syncTrackHeight();
  if (timelineNow) {
    const nowPx = Math.round(computeNowPx(state));
    if (nowPx !== lastNowPx) {
      lastNowPx = nowPx;
      (timelineNow as HTMLElement).style.top = `${nowPx}px`;
      if (timelineTrackLine) timelineTrackLine.style.height = `${nowPx}px`;
    }
  }
  if (timelineNowLabel) {
    if (state.phase === "pre")      timelineNowLabel.textContent = t("timeline.t0");
    else if (state.phase === "complete") timelineNowLabel.textContent = t("timeline.end");
    else timelineNowLabel.textContent = t("timeline.now");
  }

  // ── Timeline row states (only update when the current event changes) ──
  let newCurrentEl: HTMLElement | undefined;

  if (state.phase === "pre") {
    newCurrentEl = undefined;
  } else if (state.phase === "complete") {
    newCurrentEl = sortedRows[sortedRows.length - 1]?.el;
  } else {
    const mh = state.metHours;
    newCurrentEl = sortedRows[0]?.el;
    for (const { el, h } of sortedRows) { if (h <= mh + 1e-6) newCurrentEl = el; }
  }

  if (newCurrentEl !== lastCurrentRow) {
    lastCurrentRow = newCurrentEl;
    for (const row of timelineRows) {
      row.classList.remove("timeline-row--past", "timeline-row--current",
                           "timeline-row--future", "timeline-row--next");
    }
    if (state.phase === "pre") {
      for (const row of timelineRows) row.classList.add("timeline-row--future");
      sortedRows[0]?.el.classList.replace("timeline-row--future", "timeline-row--next");
    } else if (state.phase === "complete") {
      for (const row of timelineRows) row.classList.add("timeline-row--past");
      newCurrentEl?.classList.replace("timeline-row--past", "timeline-row--current");
    } else {
      const mh = state.metHours;
      let nextSet = false;
      for (const row of timelineRows) {
        const rh = parseFloat(row.dataset.metHours ?? "");
        if (!Number.isFinite(rh)) continue;
        if (rh < mh - 1e-3) {
          row.classList.add("timeline-row--past");
        } else if (row === newCurrentEl) {
          row.classList.add("timeline-row--current");
        } else if (!nextSet) {
          row.classList.add("timeline-row--next");
          nextSet = true;
        } else {
          row.classList.add("timeline-row--future");
        }
      }
    }
  }

  if (newCurrentEl && !mobileQuery.matches && Date.now() - userScrolledAt > SCROLL_PAUSE_MS) {
    const rect = newCurrentEl.getBoundingClientRect();
    const container = scrollEl?.getBoundingClientRect();
    if (container && (rect.top < container.top || rect.bottom > container.bottom)) {
      newCurrentEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}

updateDashboard();
setInterval(updateDashboard, 250);

/* ══════════════════════════════════════════════
   Loading screen
   ══════════════════════════════════════════════ */
const loadingScreen = document.getElementById("loading-screen");
const loadingBar    = document.getElementById("loading-bar");
const loadingText   = document.getElementById("loading-text");

function dismissLoadingScreen(): void {
  if (!loadingScreen) return;
  loadingScreen.classList.add("loading-screen--done");
  setTimeout(() => loadingScreen.remove(), 600);
}

/* ══════════════════════════════════════════════
   3D orbit scene
   ══════════════════════════════════════════════ */
const orbitCanvas   = document.getElementById("orbit-canvas") as HTMLCanvasElement | null;
const fullscreenBtn = document.getElementById("orbit-fullscreen");
let orbitApi: ReturnType<typeof createOrbitScene> | null = null;

if (orbitCanvas) {
  const loadCb: OrbitLoadCallbacks = {
    onProgress(loaded, total) {
      const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
      if (loadingBar)  loadingBar.style.width = `${pct}%`;
      if (loadingText)  loadingText.textContent = `${loaded} / ${total}`;
    },
    onReady() {
      if (loadingBar)  loadingBar.style.width = "100%";
      if (loadingText)  loadingText.textContent = "✓";
      setTimeout(dismissLoadingScreen, 400);
    },
  };

  try {
    orbitApi = createOrbitScene(orbitCanvas, {
      getProgress: () => getMissionState().progress,
    }, loadCb);
    window.addEventListener("resize", () => orbitApi?.resize());
    fullscreenBtn?.addEventListener("click", () => orbitApi?.toggleFullscreen());

    // Kapsel-Fokus Button
    document.getElementById("orbit-craft-focus")?.addEventListener("click", () => orbitApi?.focusCraft());

    // Timeline-Klick → 3D fokussiert den Missionspunkt
    document.querySelectorAll<HTMLElement>(".timeline-row[data-met-hours]").forEach((row) => {
      row.style.cursor = "pointer";
      row.addEventListener("click", () => {
        const met = parseFloat(row.dataset.metHours ?? "0");
        orbitApi?.flyToMET(met);
      });
    });
  } catch (e) {
    console.warn("Orbit 3D unavailable:", e);
    (orbitCanvas.closest(".orbit-panel") as HTMLElement)?.style.setProperty("background", "#0b0b0b");
    dismissLoadingScreen();
  }
} else {
  dismissLoadingScreen();
}

/* ══════════════════════════════════════════════
   Locale changes
   ══════════════════════════════════════════════ */
onLocaleChange(() => {
  updateDashboard();
  localFmt = buildLocalTimeFormatter();
  injectLocalTimes();
  orbitApi?.updateLabels?.();
});

/* ══════════════════════════════════════════════
   Credits dialog
   ══════════════════════════════════════════════ */
{
  const dialog = document.getElementById("credits-dialog") as HTMLDialogElement | null;
  const openBtn = document.getElementById("credits-open");
  const closeBtn = document.getElementById("credits-close");

  openBtn?.addEventListener("click", () => dialog?.showModal());
closeBtn?.addEventListener("click", () => dialog?.close());
  dialog?.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

/* ══════════════════════════════════════════════
   Mobile tab bar
   ══════════════════════════════════════════════ */
{
  const mainContent = document.querySelector<HTMLElement>(".main-content");
  const tabs = document.querySelectorAll<HTMLButtonElement>(".mobile-tab");

  // On mobile: move toolbar out of orbit-panel into mobile-content-area
  // so it stays visible on all tabs
  if (window.innerWidth <= 680) {
    const toolbar = document.querySelector<HTMLElement>(".orbit-controls-toolbar");
    const contentArea = document.querySelector<HTMLElement>(".mobile-content-area");
    if (toolbar && contentArea) {
      contentArea.appendChild(toolbar);
    }
  }

  if (mainContent && tabs.length) {
    // Set initial state
    mainContent.dataset.mobileTab = "orbit";

    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab ?? "orbit";
        mainContent.dataset.mobileTab = target;
        tabs.forEach(t => {
          t.classList.toggle("mobile-tab--active", t.dataset.tab === target);
          t.setAttribute("aria-pressed", String(t.dataset.tab === target));
        });
        // Resize orbit scene when switching back to orbit tab
        if (target === "orbit") {
          setTimeout(() => orbitApi?.resize(), 50);
        }
      });
    });
  }
}
