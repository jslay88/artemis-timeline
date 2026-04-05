/** Artemis II reference launch (browser-local instant via ISO string). */
export const LAUNCH = new Date("2026-04-01T18:35:12-04:00");

/** MET 09/01:46 from overview — mission duration from liftoff. */
const MISSION_DURATION_MS = (9 * 24 + 1 + 46 / 60) * 3600 * 1000;

export const SPLASH = new Date(LAUNCH.getTime() + MISSION_DURATION_MS);

type MissionPhase = "pre" | "flight" | "complete";

export interface MissionState {
  phase: MissionPhase;
  progress: number;
  elapsedMs: number;
  metHours: number;
  metLabel: string;
  toLaunchMs: number;
  remainingMs: number;
}

/**
 * Format decimal hours as MET "dd/hh:mm:ss" (chart-style day/hh:mm:ss from liftoff).
 */
export function formatMET(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "00/00:00:00";
  const totalSec = Math.floor(hours * 3600);
  const days = Math.floor(totalSec / 86400);
  const rem = totalSec - days * 86400;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  return `${String(days).padStart(2, "0")}/${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Wall-clock time in the visitor's locale and time zone (for timeline labels).
 */
export function formatLocaleDateTime(date: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/** Phase, progress, MET, and countdown fields relative to `now`. */
export function getMissionState(now: Date = new Date()): MissionState {
  const t = now.getTime();
  const t0 = LAUNCH.getTime();
  const t1 = SPLASH.getTime();
  const totalMs = t1 - t0;

  if (t < t0) {
    return {
      phase: "pre",
      progress: 0,
      elapsedMs: 0,
      metHours: 0,
      metLabel: "00/00:00:00",
      toLaunchMs: t0 - t,
      remainingMs: t1 - t,
    };
  }
  if (t > t1) {
    return {
      phase: "complete",
      progress: 1,
      elapsedMs: totalMs,
      metHours: totalMs / 3600000,
      metLabel: formatMET(totalMs / 3600000),
      toLaunchMs: 0,
      remainingMs: 0,
    };
  }

  const elapsedMs = t - t0;
  const progress = elapsedMs / totalMs;
  const metHours = elapsedMs / 3600000;

  return {
    phase: "flight",
    progress,
    elapsedMs,
    metHours,
    metLabel: formatMET(metHours),
    toLaunchMs: 0,
    remainingMs: t1 - t,
  };
}

/** Format ms as "Xd Xh Xm Xs" for countdowns. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (h || days) parts.push(`${h}h`);
  if (m || h || days) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}
