// ephemeris.ts — Real NASA/JSC CCSDS OEM trajectory data for Artemis II
// Parses the OEM file once at module load, provides O(log n) interpolation.

import rawOem from "../Artemis_II_OEM_2026_04_04_to_EI.asc?raw";
import * as THREE from "three";

// ─── Constants ─────────────────────────────────────────────────────────────
export const R_EARTH = 6371;      // km — 1 scene unit
const SCALE = 1 / R_EARTH;
const LAUNCH_MS = new Date("2026-04-01T22:35:12Z").getTime();

// Moon EME2000/ICRF position from JPL DE441 ephemeris (via Horizons API) at
// closest approach time 2026-04-06T23:05:51 UTC (MET +120.511 h).
// Actual Earth-Moon distance at this epoch: ~404,740 km (Moon near apogee).
// Validated: min OEM trajectory-to-Moon distance = 8,428 km (6,691 km above surface).
const MOON_EME_X = -129031;
const MOON_EME_Y = -335933;
const MOON_EME_Z = -185241;

// ─── Types ─────────────────────────────────────────────────────────────────
export interface StateVector {
  utcMs: number;  // ms since Unix epoch
  x: number;      // km  EME2000 Earth-centered
  y: number;
  z: number;
  vx: number;     // km/s
  vy: number;
  vz: number;
}

export interface TelemetrySample {
  speed: number;               // km/s (magnitude of velocity)
  distanceFromEarth: number;   // km (from Earth center)
  altitudeAboveEarth: number;  // km (above surface)
}

// ─── OEM Parser ────────────────────────────────────────────────────────────
// Data lines look like: "2026-04-02T01:57:37.084 x y z vx vy vz"
// All other lines (CCSDS header, META, COMMENT) don't start with a digit.
function parseOEM(text: string): StateVector[] {
  const result: StateVector[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length < 30 || t.charCodeAt(0) < 48 || t.charCodeAt(0) > 57) continue;

    const p = t.split(/\s+/);
    if (p.length < 7) continue;

    const utcMs = new Date(p[0] + "Z").getTime();
    if (isNaN(utcMs)) continue;

    result.push({
      utcMs,
      x:  +p[1], y:  +p[2], z:  +p[3],
      vx: +p[4], vy: +p[5], vz: +p[6],
    });
  }
  return result;
}

// Parse once at module load (runs synchronously during JS init)
const _sv: StateVector[] = parseOEM(rawOem);

// ─── Binary search ─────────────────────────────────────────────────────────
function bsearch(ms: number): number {
  let lo = 0, hi = _sv.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (_sv[mid].utcMs <= ms) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ─── Interpolation ─────────────────────────────────────────────────────────
export function interpolateState(utcMs: number): StateVector {
  if (_sv.length === 0) return { utcMs, x:0, y:0, z:R_EARTH, vx:0, vy:0, vz:0 };
  if (utcMs <= _sv[0].utcMs)              return _sv[0];
  if (utcMs >= _sv[_sv.length - 1].utcMs) return _sv[_sv.length - 1];

  const i = bsearch(utcMs);
  const a = _sv[i];
  const b = _sv[i + 1];
  const t = (utcMs - a.utcMs) / (b.utcMs - a.utcMs);

  return {
    utcMs,
    x:  a.x  + t * (b.x  - a.x),
    y:  a.y  + t * (b.y  - a.y),
    z:  a.z  + t * (b.z  - a.z),
    vx: a.vx + t * (b.vx - a.vx),
    vy: a.vy + t * (b.vy - a.vy),
    vz: a.vz + t * (b.vz - a.vz),
  };
}

// ─── Coordinate transform: EME2000 km → Three.js scene units ───────────────
// EME2000: X=vernal equinox, Y=90°E equatorial, Z=north pole
// Three.js: X=right, Y=up (north), Z=toward viewer (right-handed)
// Mapping: THREE.x = EME2000.x, THREE.y = EME2000.z, THREE.z = -EME2000.y
export function eme2000ToThree(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x * SCALE, z * SCALE, -y * SCALE);
}

// ─── Telemetry sample ──────────────────────────────────────────────────────
export function getTelemetry(utcMs: number): TelemetrySample {
  const sv = interpolateState(utcMs);
  const r = Math.sqrt(sv.x * sv.x + sv.y * sv.y + sv.z * sv.z);
  const speed = Math.sqrt(sv.vx * sv.vx + sv.vy * sv.vy + sv.vz * sv.vz);
  return {
    speed,
    distanceFromEarth:   r,
    altitudeAboveEarth:  r - R_EARTH,
  };
}

// ─── Trajectory points for 3D curve ──────────────────────────────────────
// Spans the FULL mission: Launch (MET 0) → Splashdown (MET 217.767h).
// Pre-OEM segment (launch → first OEM point) and post-OEM segment (last OEM
// point → splashdown) are smoothly interpolated from Earth's surface.
// Time-uniform sampling ensures curve parameter `t` maps linearly to MET.
const TOTAL_MET_H = 217.767;

export function getTrajectoryPoints(n = 800): THREE.Vector3[] {
  if (_sv.length === 0) return [];

  const missionStartMs = LAUNCH_MS;
  const missionEndMs   = LAUNCH_MS + TOTAL_MET_H * 3600000;
  const oemStartMs     = _sv[0].utcMs;
  const oemEndMs       = _sv[_sv.length - 1].utcMs;

  const firstOem = eme2000ToThree(_sv[0].x, _sv[0].y, _sv[0].z);
  const lastOem  = eme2000ToThree(
    _sv[_sv.length - 1].x, _sv[_sv.length - 1].y, _sv[_sv.length - 1].z,
  );
  const launchSurf = firstOem.clone().normalize();
  const splashSurf = lastOem.clone().normalize();

  const out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    const tMs  = missionStartMs + frac * (missionEndMs - missionStartMs);

    if (tMs < oemStartMs) {
      // Pre-OEM: smooth arc from Earth surface toward the first OEM position
      const f = (tMs - missionStartMs) / (oemStartMs - missionStartMs);
      const s = f * f * (3 - 2 * f); // smoothstep for natural launch arc
      out.push(new THREE.Vector3().lerpVectors(launchSurf, firstOem, s));
    } else if (tMs > oemEndMs) {
      // Post-OEM: smooth arc from last OEM position back to Earth surface
      const f = (tMs - oemEndMs) / (missionEndMs - oemEndMs);
      const s = f * f * (3 - 2 * f);
      out.push(new THREE.Vector3().lerpVectors(lastOem, splashSurf, s));
    } else {
      const sv = interpolateState(tMs);
      out.push(eme2000ToThree(sv.x, sv.y, sv.z));
    }
  }
  return out;
}

// ─── Position at MET ──────────────────────────────────────────────────────
// Returns the Three.js scene position for a given MET (hours from launch).
// Uses OEM interpolation directly — not the curve parameterization.
export function getPositionAtMET(metHours: number): THREE.Vector3 {
  const utcMs = LAUNCH_MS + metHours * 3600000;
  const sv = interpolateState(utcMs);
  return eme2000ToThree(sv.x, sv.y, sv.z);
}

// ─── Moon position ─────────────────────────────────────────────────────────
// Moon EME2000 position from JPL DE441, converted to Three.js scene units.
// Uses the Moon's actual position at closest approach so the trajectory
// visually passes near the Moon at the correct distance.
export function getMoonPosition(): THREE.Vector3 {
  return eme2000ToThree(MOON_EME_X, MOON_EME_Y, MOON_EME_Z);
}

// ─── OEM metadata ──────────────────────────────────────────────────────────
export function getEphemerisRange(): { startMs: number; endMs: number; count: number } {
  return {
    startMs: _sv.length > 0 ? _sv[0].utcMs          : 0,
    endMs:   _sv.length > 0 ? _sv[_sv.length-1].utcMs : 0,
    count:   _sv.length,
  };
}

// Curve parameterization spans the FULL mission (Launch → Splashdown),
// matching the trajectory points that include pre/post-OEM extensions.
export const OEM_START_MET_H = 0;
export const OEM_END_MET_H   = TOTAL_MET_H;
