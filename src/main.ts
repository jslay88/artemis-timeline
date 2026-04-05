import "./styles.css";
import {
  getMissionState,
  formatMET,
  formatCountdown,
  LAUNCH,
  SPLASH,
  type MissionState,
} from "./mission.ts";
import { createOrbitScene } from "./orbit-scene.ts";
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

  // ── Timeline marker ──
  if (timelineNow) {
    const nowPx = computeNowPx(state);
    (timelineNow as HTMLElement).style.top = `${nowPx}px`;
    if (timelineNowLabel) {
      if (state.phase === "pre")      timelineNowLabel.textContent = t("timeline.t0");
      else if (state.phase === "complete") timelineNowLabel.textContent = t("timeline.end");
      else timelineNowLabel.textContent = t("timeline.now");
    }
  }

  // ── Timeline row states ──
  for (const row of timelineRows) {
    row.classList.remove("timeline-row--past", "timeline-row--current",
                         "timeline-row--future", "timeline-row--next");
  }

  if (state.phase === "pre") {
    for (const row of timelineRows) row.classList.add("timeline-row--future");
    sortedRows[0]?.el.classList.replace("timeline-row--future", "timeline-row--next");
  } else if (state.phase === "complete") {
    for (const row of timelineRows) row.classList.add("timeline-row--past");
    const last = sortedRows[sortedRows.length - 1]?.el;
    last?.classList.replace("timeline-row--past", "timeline-row--current");
  } else {
    const mh = state.metHours;
    let currentEl = sortedRows[0]?.el;
    for (const { el, h } of sortedRows) { if (h <= mh + 1e-6) currentEl = el; }
    for (const row of timelineRows) {
      const rh = parseFloat(row.dataset.metHours ?? "");
      if (!Number.isFinite(rh)) continue;
      if (rh < mh - 1e-3)   row.classList.add("timeline-row--past");
      else if (row === currentEl) row.classList.add("timeline-row--current");
      else                   row.classList.add("timeline-row--future");
    }
    // Scroll current row into view (gently)
    if (currentEl) {
      const rect = currentEl.getBoundingClientRect();
      const container = scrollEl?.getBoundingClientRect();
      if (container && (rect.top < container.top || rect.bottom > container.bottom)) {
        currentEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }
}

updateDashboard();
setInterval(updateDashboard, 250);

/* ══════════════════════════════════════════════
   3D orbit scene
   ══════════════════════════════════════════════ */
const orbitCanvas   = document.getElementById("orbit-canvas") as HTMLCanvasElement | null;
const fullscreenBtn = document.getElementById("orbit-fullscreen");
let orbitApi: ReturnType<typeof createOrbitScene> | null = null;

if (orbitCanvas) {
  try {
    orbitApi = createOrbitScene(orbitCanvas, {
      getProgress: () => getMissionState().progress,
    });
    window.addEventListener("resize", () => orbitApi?.resize());
    fullscreenBtn?.addEventListener("click", () => orbitApi?.toggleFullscreen());
  } catch (e) {
    console.warn("Orbit 3D unavailable:", e);
    (orbitCanvas.closest(".orbit-panel") as HTMLElement)?.style.setProperty("background", "#0b0b0b");
  }
}

/* ══════════════════════════════════════════════
   Locale changes
   ══════════════════════════════════════════════ */
onLocaleChange(() => {
  updateDashboard();
  orbitApi?.updateLabels?.();
});
