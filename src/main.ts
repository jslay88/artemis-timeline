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
import { createSpeedChart, createDistanceChart, type MissionChart } from "./telemetry-charts.ts";

/* ══════════════════════════════════════════════
   i18n bootstrap + locale picker
   ══════════════════════════════════════════════ */
initI18n();

{
  const picker = document.getElementById("locale-picker");
  if (picker) {
    const sel = document.createElement("select");
    sel.className = "locale-picker__select";
    sel.setAttribute("aria-label", "Language");
    for (const { code, name, flag } of getLocales()) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = flag ? `${flag}  ${name}` : name;
      if (code === getLocale()) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", (): void => { setLocale(sel.value); });
    picker.appendChild(sel);
    onLocaleChange((code: string) => { sel.value = code; });
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
let speedChart: MissionChart | null = null;
let distChart:  MissionChart | null = null;

const speedCanvas = document.getElementById("chart-speed") as HTMLCanvasElement | null;
const distCanvas  = document.getElementById("chart-distance") as HTMLCanvasElement | null;

if (speedCanvas) {
  try { speedChart = createSpeedChart(speedCanvas); } catch (e) { console.warn("Speed chart:", e); }
}
if (distCanvas) {
  try { distChart = createDistanceChart(distCanvas); } catch (e) { console.warn("Distance chart:", e); }
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
  if (telAltitude) telAltitude.textContent = Math.round(tel.altitudeAboveEarth).toLocaleString();

  // ── Orbit phase label ──
  if (orbitPhaseLabel && state.phase === "flight") {
    orbitPhaseLabel.textContent = getPhaseName(metHours);
  }

  // ── Chart needles ──
  speedChart?.setNeedle(metHours);
  distChart?.setNeedle(metHours);

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
      for (const row of timelineRows) {
        const rh = parseFloat(row.dataset.metHours ?? "");
        if (!Number.isFinite(rh)) continue;
        if (rh < mh - 1e-3)   row.classList.add("timeline-row--past");
        else if (row === newCurrentEl) row.classList.add("timeline-row--current");
        else                   row.classList.add("timeline-row--future");
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
