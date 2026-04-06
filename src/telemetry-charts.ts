// telemetry-charts.ts
// Chart.js wrappers for Artemis II mission velocity and distance profiles.
// Uses tree-shaken imports — no chart.js/auto.

import {
  Chart,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Filler,
  Tooltip,
  type ChartConfiguration,
  type Plugin,
} from "chart.js";

import { getTelemetry, OEM_END_MET_H } from "./ephemeris";

Chart.register(LineController, LineElement, LinearScale, PointElement, Filler, Tooltip);

// ─── Shared Colors ─────────────────────────────────────────────────────────
const COLOR_LINE    = "#FFFFFF";
const COLOR_FILL    = "rgba(255,255,255,0.04)";
const COLOR_NEEDLE  = "#FC3D21";  // NASA orange
const COLOR_GRID    = "rgba(255,255,255,0.06)";
const COLOR_TEXT    = "#666666";

const LAUNCH_MS = new Date("2026-04-01T22:35:12Z").getTime();

// ─── Precomputed Table from real OEM data (singleton) ─────────────────────
interface ChartTable {
  metHours: number[];
  speed: number[];
  distance: number[];
  altEarth: (number | null)[];
  altMoon: (number | null)[];
}

let _table: ChartTable | null = null;
function getTable(): ChartTable {
  if (_table) return _table;

  const n = 800;
  const metHours: number[] = [];
  const speed: number[] = [];
  const distance: number[] = [];
  const altEarth: (number | null)[] = [];
  const altMoon: (number | null)[] = [];

  for (let i = 0; i < n; i++) {
    const mh = (i / (n - 1)) * OEM_END_MET_H;
    const utcMs = LAUNCH_MS + mh * 3600000;
    const tel = getTelemetry(utcMs);

    metHours.push(mh);
    speed.push(tel.speed);
    distance.push(tel.distanceFromEarth);

    if (tel.altitudeBody === "moon") {
      altEarth.push(null);
      altMoon.push(tel.altitude / 1000);
    } else {
      altEarth.push(tel.altitude / 1000);
      altMoon.push(null);
    }
  }

  _table = { metHours, speed, distance, altEarth, altMoon };
  return _table;
}

// ─── Custom "now" needle plugin ────────────────────────────────────────────
function makeNeedlePlugin(getNeedle: () => number): Plugin<"line"> {
  return {
    id: "needleLine",
    afterDraw(chart) {
      const { ctx, scales, chartArea } = chart;
      const x = scales["x"];
      if (!x) return;
      const needleX = x.getPixelForValue(getNeedle());
      if (needleX < chartArea.left || needleX > chartArea.right) return;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(needleX, chartArea.top);
      ctx.lineTo(needleX, chartArea.bottom);
      ctx.strokeStyle = COLOR_NEEDLE;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
    },
  };
}

// ─── Shared chart config factory ───────────────────────────────────────────
function baseConfig(
  labels: number[],
  data: number[],
  getNeedle: () => number,
  yLabel: string
): ChartConfiguration<"line"> {
  return {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor:           COLOR_LINE,
          borderWidth:           1.5,
          backgroundColor:       COLOR_FILL,
          fill:                  true,
          pointRadius:           0,
          pointHoverRadius:      0,
          tension:               0.3,
        },
      ],
    },
    options: {
      animation:   false,
      responsive:  true,
      maintainAspectRatio: false,
      layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
      plugins: {
        legend:  { display: false },
        tooltip: {
          enabled: true,
          mode: "index",
          intersect: false,
          backgroundColor: "#111111",
          borderColor:     "rgba(255,255,255,0.1)",
          borderWidth:     1,
          titleColor:      "#888888",
          bodyColor:       "#FFFFFF",
          titleFont: { family: "IBM Plex Mono", size: 10 },
          bodyFont:  { family: "IBM Plex Mono", size: 12, weight: "bold" },
          callbacks: {
            title: (items) => `MET ${items[0].label}h`,
            label: (item)  => `${yLabel}: ${Number(item.raw).toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min:  0,
          max:  218,
          ticks: {
            color:     COLOR_TEXT,
            font:      { family: "IBM Plex Mono", size: 9 },
            maxTicksLimit: 12,
            callback: (v) => `${v}h`,
          },
          grid:   { color: COLOR_GRID },
          border: { color: COLOR_GRID },
        },
        y: {
          type: "linear",
          ticks: {
            color: COLOR_TEXT,
            font:  { family: "IBM Plex Mono", size: 9 },
            maxTicksLimit: 5,
          },
          grid:   { color: COLOR_GRID },
          border: { color: COLOR_GRID },
        },
      },
    },
    plugins: [makeNeedlePlugin(getNeedle)],
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface MissionChart {
  chart:     Chart<"line">;
  setNeedle: (metHours: number) => void;
}

export function createSpeedChart(canvas: HTMLCanvasElement): MissionChart {
  const table  = getTable();

  let needleValue = 0;
  const getNeedle = () => needleValue;

  const cfg = baseConfig(table.metHours, table.speed, getNeedle, "km/s");
  const chart = new Chart(canvas, cfg);

  return {
    chart,
    setNeedle(metHours) {
      needleValue = metHours;
      chart.render();
    },
  };
}

export function createDistanceChart(canvas: HTMLCanvasElement): MissionChart {
  const table  = getTable();
  const data   = table.distance.map((d) => d / 1000);

  let needleValue = 0;
  const getNeedle = () => needleValue;

  const cfg = baseConfig(table.metHours, data, getNeedle, "×1000 km");
  if (cfg.options?.scales?.["y"]?.ticks) {
    (cfg.options.scales["y"].ticks as { callback?: (v: unknown) => string }).callback =
      (v) => `${Number(v).toFixed(0)}k`;
  }
  const chart = new Chart(canvas, cfg);

  return {
    chart,
    setNeedle(metHours) {
      needleValue = metHours;
      chart.render();
    },
  };
}

// ─── Altitude chart with SOI coloring ─────────────────────────────────────

const COLOR_EARTH_SOI = "#4dabf7"; // blue
const COLOR_EARTH_FILL = "rgba(77, 171, 247, 0.08)";
const COLOR_MOON_SOI  = "#a0a0a0"; // silver
const COLOR_MOON_FILL = "rgba(160, 160, 160, 0.08)";

export function createAltitudeChart(canvas: HTMLCanvasElement): MissionChart {
  const table  = getTable();

  let needleValue = 0;
  const getNeedle = () => needleValue;

  const cfg: ChartConfiguration<"line"> = {
    type: "line",
    data: {
      labels: table.metHours,
      datasets: [
        {
          label: "Earth SOI",
          data: table.altEarth,
          borderColor: COLOR_EARTH_SOI,
          borderWidth: 1.5,
          backgroundColor: COLOR_EARTH_FILL,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.3,
          spanGaps: false,
        },
        {
          label: "Moon SOI",
          data: table.altMoon,
          borderColor: COLOR_MOON_SOI,
          borderWidth: 1.5,
          backgroundColor: COLOR_MOON_FILL,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.3,
          spanGaps: false,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "end",
          labels: {
            color: COLOR_TEXT,
            font: { family: "IBM Plex Mono", size: 9 },
            boxWidth: 12,
            boxHeight: 2,
            padding: 6,
          },
        },
        tooltip: {
          enabled: true,
          mode: "index",
          intersect: false,
          backgroundColor: "#111111",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 1,
          titleColor: "#888888",
          bodyColor: "#FFFFFF",
          titleFont: { family: "IBM Plex Mono", size: 10 },
          bodyFont: { family: "IBM Plex Mono", size: 12, weight: "bold" },
          filter: (item) => item.raw !== null,
          callbacks: {
            title: (items) => `MET ${items[0].label}h`,
            label: (item) => {
              const body = item.datasetIndex === 0 ? "⊕" : "☽";
              return `${body} ${Number(item.raw).toFixed(1)} ×1000 km`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: 218,
          ticks: {
            color: COLOR_TEXT,
            font: { family: "IBM Plex Mono", size: 9 },
            maxTicksLimit: 12,
            callback: (v) => `${v}h`,
          },
          grid: { color: COLOR_GRID },
          border: { color: COLOR_GRID },
        },
        y: {
          type: "linear",
          ticks: {
            color: COLOR_TEXT,
            font: { family: "IBM Plex Mono", size: 9 },
            maxTicksLimit: 5,
            callback: (v) => `${Number(v).toFixed(0)}k`,
          },
          grid: { color: COLOR_GRID },
          border: { color: COLOR_GRID },
        },
      },
    },
    plugins: [makeNeedlePlugin(getNeedle)],
  };

  const chart = new Chart(canvas, cfg);

  return {
    chart,
    setNeedle(metHours) {
      needleValue = metHours;
      chart.render();
    },
  };
}
