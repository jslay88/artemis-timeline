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

import { buildTelemetryTable, type TelemetryTable } from "./trajectory-physics";

Chart.register(LineController, LineElement, LinearScale, PointElement, Filler, Tooltip);

// ─── Shared Colors ─────────────────────────────────────────────────────────
const COLOR_LINE    = "#FFFFFF";
const COLOR_FILL    = "rgba(255,255,255,0.04)";
const COLOR_NEEDLE  = "#FC3D21";  // NASA orange
const COLOR_GRID    = "rgba(255,255,255,0.06)";
const COLOR_TEXT    = "#666666";

// ─── Precomputed Table (singleton) ─────────────────────────────────────────
let _table: TelemetryTable | null = null;
function getTable(): TelemetryTable {
  if (!_table) _table = buildTelemetryTable(800);
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
  const labels = Array.from(table.metHours);
  const data   = Array.from(table.speed);

  let needleValue = 0;
  const getNeedle = () => needleValue;

  const cfg = baseConfig(labels, data, getNeedle, "km/s");
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
  const labels = Array.from(table.metHours);
  // Convert km from Earth center → thousands of km for readability
  const data   = Array.from(table.distance).map((d) => d / 1000);

  let needleValue = 0;
  const getNeedle = () => needleValue;

  const cfg = baseConfig(labels, data, getNeedle, "×1000 km");
  // Adjust y-axis label
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
