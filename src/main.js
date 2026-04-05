import "./styles.css";
import {
  getMissionState,
  formatMET,
  formatCountdown,
  formatLocaleDateTime,
  LAUNCH,
  SPLASH,
} from "./mission.js";
import { createOrbitScene } from "./orbit-scene.js";
import {
  initI18n,
  t,
  setLocale,
  getLocale,
  getLocales,
  onLocaleChange,
  applyI18nToDom,
} from "./i18n.js";

/* ——— i18n bootstrap + locale picker ——— */

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
    sel.addEventListener("change", () => setLocale(sel.value));
    picker.appendChild(sel);
    onLocaleChange((code) => { sel.value = code; });
  }
}

/* ——— Enrich timeline with local times ——— */

function enrichTimelineLocale() {
  const rows = document.querySelectorAll(".timeline-row[data-met-hours]");
  for (const row of rows) {
    const h = parseFloat(row.dataset.metHours, 10);
    if (!Number.isFinite(h)) continue;
    const when = new Date(LAUNCH.getTime() + h * 3600000);
    const local = formatLocaleDateTime(when);

    const metEl = row.querySelector(".event__met");
    if (metEl) {
      if (!metEl.dataset.chart) metEl.dataset.chart = metEl.textContent.trim();
      metEl.replaceChildren();
      const timeEl = document.createElement("time");
      timeEl.className = "event__met-local";
      timeEl.dateTime = when.toISOString();
      timeEl.textContent = local;
      const sub = document.createElement("span");
      sub.className = "event__met-chart";
      sub.textContent = metEl.dataset.chart;
      metEl.appendChild(timeEl);
      metEl.appendChild(sub);
    }

    const metaEl = row.querySelector(".phase-block__meta");
    if (metaEl) {
      const metaKey = row.dataset.i18nMeta;
      metaEl.replaceChildren();
      const timeEl = document.createElement("time");
      timeEl.className = "phase-block__meta-local";
      timeEl.dateTime = when.toISOString();
      timeEl.textContent = local;
      metaEl.appendChild(timeEl);
      if (metaKey) {
        const sub = document.createElement("span");
        sub.className = "phase-block__meta-sub";
        sub.textContent = t(metaKey);
        metaEl.appendChild(sub);
      }
    }
  }

  const launchTimeEl = document.querySelector(".hero__launch-time");
  if (launchTimeEl) {
    const iso = launchTimeEl.getAttribute("datetime");
    if (iso) {
      launchTimeEl.textContent = formatLocaleDateTime(new Date(iso));
    }
  }
}

enrichTimelineLocale();

/* ——— Background starfield canvas ——— */

const canvas = document.getElementById("starfield");
const ctx = canvas.getContext("2d");

let stars = [];
let w = 0;
let h = 0;
let raf = 0;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function resizeStarfield() {
  w = canvas.width = window.innerWidth * devicePixelRatio;
  h = canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  initStars();
}

function initStars() {
  const count = Math.min(420, Math.floor((w * h) / 9000));
  stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random() * 0.85 + 0.15,
      s: Math.random() * 1.8 + 0.2,
    });
  }
}

function tick(t) {
  if (prefersReducedMotion) { drawStatic(); return; }
  ctx.fillStyle = "#03060d";
  ctx.fillRect(0, 0, w, h);

  const twinkle = t * 0.0008;
  for (let i = 0; i < stars.length; i++) {
    const st = stars[i];
    const pulse = 0.55 + 0.45 * Math.sin(twinkle + i * 0.7);
    const alpha = st.z * pulse;
    ctx.beginPath();
    ctx.fillStyle = `rgba(200, 230, 255, ${alpha * 0.85})`;
    ctx.arc(st.x, st.y, st.s * st.z, 0, Math.PI * 2);
    ctx.fill();
    st.y += 0.03 * st.z;
    if (st.y > h) { st.y = 0; st.x = Math.random() * w; }
  }

  const g = ctx.createRadialGradient(w * 0.5, h * 0.1, 0, w * 0.5, h * 0.1, w * 0.6);
  g.addColorStop(0, "rgba(30, 80, 120, 0.12)");
  g.addColorStop(1, "rgba(3, 6, 13, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  raf = requestAnimationFrame(tick);
}

function drawStatic() {
  ctx.fillStyle = "#03060d";
  ctx.fillRect(0, 0, w, h);
  for (const st of stars) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(200, 230, 255, ${st.z * 0.55})`;
    ctx.arc(st.x, st.y, st.s * st.z, 0, Math.PI * 2);
    ctx.fill();
  }
}

window.addEventListener("resize", () => {
  cancelAnimationFrame(raf);
  resizeStarfield();
  if (!prefersReducedMotion) raf = requestAnimationFrame(tick);
  else drawStatic();
});

resizeStarfield();
if (!prefersReducedMotion) raf = requestAnimationFrame(tick);
else drawStatic();

/* ——— Scroll reveal ——— */

const animated = document.querySelectorAll("[data-animate]");
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
    }
  },
  { root: null, rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
);

for (const el of animated) {
  if (prefersReducedMotion) el.classList.add("is-visible");
  else io.observe(el);
}

const hintBtn = document.querySelector(".scroll-hint");
const timelineEl = document.querySelector(".timeline-wrap");
hintBtn?.addEventListener("click", () => {
  timelineEl?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
});

if (!prefersReducedMotion) {
  document.querySelectorAll(".timeline > li").forEach((el, i) => {
    const target = el.querySelector("[data-animate]") || (el.hasAttribute("data-animate") ? el : null);
    if (target) target.style.transitionDelay = `${Math.min(i * 0.035, 0.55)}s`;
  });
}

/* ——— Mission clock + timeline marker ——— */

const missionHudPhase = document.getElementById("mission-hud-phase");
const missionHudMet = document.getElementById("mission-hud-met");
const missionHudSubLabel = document.getElementById("mission-hud-sub-label");
const missionHudSubValue = document.getElementById("mission-hud-sub-value");
const timelineNow = document.getElementById("timeline-now");
const timelineNowLabel = document.getElementById("timeline-now-label");
const timelineRows = [...document.querySelectorAll(".timeline-row")];

const sortedRows = timelineRows
  .map((el) => ({ el, h: parseFloat(el.dataset.metHours, 10) }))
  .filter((x) => Number.isFinite(x.h))
  .sort((a, b) => a.h - b.h);

const TOTAL_MET_HOURS = (SPLASH.getTime() - LAUNCH.getTime()) / 3600000;

function rowMidY(el) {
  return el.offsetTop + el.offsetHeight / 2;
}

function computeNowPx(state) {
  if (sortedRows.length === 0) return 0;

  if (state.phase === "pre") {
    return sortedRows[0].el.offsetTop;
  }
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
      const aY = rowMidY(a.el);
      const bY = rowMidY(b.el);
      const t = (mh - a.h) / (b.h - a.h);
      return aY + t * (bY - aY);
    }
  }
  return rowMidY(last.el);
}

function updateMissionUi() {
  const state = getMissionState();

  if (missionHudPhase) {
    if (state.phase === "pre") missionHudPhase.textContent = t("hud.preLaunch");
    else if (state.phase === "complete") missionHudPhase.textContent = t("hud.missionComplete");
    else missionHudPhase.textContent = t("hud.inFlight");
  }

  if (missionHudMet) {
    if (state.phase === "pre") missionHudMet.textContent = "00/00:00:00";
    else if (state.phase === "complete") missionHudMet.textContent = formatMET(TOTAL_MET_HOURS);
    else missionHudMet.textContent = state.metLabel;
  }

  if (missionHudSubLabel && missionHudSubValue) {
    if (state.phase === "pre") {
      missionHudSubLabel.textContent = t("hud.timeToLaunch");
      missionHudSubValue.textContent = formatCountdown(state.toLaunchMs);
    } else if (state.phase === "complete") {
      missionHudSubLabel.textContent = t("hud.splashdown");
      missionHudSubValue.textContent = formatLocaleDateTime(SPLASH);
    } else {
      missionHudSubLabel.textContent = t("hud.timeToSplashdown");
      missionHudSubValue.textContent = formatCountdown(state.remainingMs);
    }
  }

  if (timelineNow) {
    const nowPx = computeNowPx(state);
    timelineNow.style.top = `${nowPx}px`;
    timelineNow.style.opacity = "1";
    if (timelineNowLabel) {
      if (state.phase === "pre") timelineNowLabel.textContent = t("timeline.t0");
      else if (state.phase === "complete") timelineNowLabel.textContent = t("timeline.end");
      else timelineNowLabel.textContent = t("timeline.now");
    }
  }

  for (const row of timelineRows) {
    row.classList.remove("timeline-row--past", "timeline-row--current", "timeline-row--future", "timeline-row--next");
  }

  if (state.phase === "pre") {
    for (const row of timelineRows) row.classList.add("timeline-row--future");
    const first = sortedRows[0]?.el;
    if (first) { first.classList.remove("timeline-row--future"); first.classList.add("timeline-row--next"); }
  } else if (state.phase === "complete") {
    for (const row of timelineRows) row.classList.add("timeline-row--past");
    const last = sortedRows[sortedRows.length - 1]?.el;
    if (last) { last.classList.remove("timeline-row--past"); last.classList.add("timeline-row--current"); }
  } else {
    const mh = state.metHours;
    let currentEl = sortedRows[0]?.el;
    for (const { el, h } of sortedRows) { if (h <= mh + 1e-6) currentEl = el; }
    for (const row of timelineRows) {
      const rh = parseFloat(row.dataset.metHours, 10);
      if (!Number.isFinite(rh)) continue;
      if (rh < mh - 1e-3) row.classList.add("timeline-row--past");
      else if (row === currentEl) row.classList.add("timeline-row--current");
      else row.classList.add("timeline-row--future");
    }
  }
}

updateMissionUi();
setInterval(updateMissionUi, 250);

/* ——— 3D orbit scene ——— */

const orbitCanvas = document.getElementById("orbit-canvas");
const fullscreenBtn = document.getElementById("orbit-fullscreen");
let orbitApi = null;

if (orbitCanvas) {
  try {
    orbitApi = createOrbitScene(orbitCanvas, {
      getProgress: () => getMissionState().progress,
    });
    window.addEventListener("resize", () => orbitApi?.resize());
    fullscreenBtn?.addEventListener("click", () => orbitApi?.toggleFullscreen());
  } catch (e) {
    console.warn("Orbit 3D unavailable:", e);
    orbitCanvas.closest(".hero__orbit")?.setAttribute("hidden", "");
  }
}

/* ——— React to locale changes ——— */

onLocaleChange(() => {
  enrichTimelineLocale();
  updateMissionUi();
  orbitApi?.updateLabels?.();
});
