// ephemeris.ts — Real NASA/JSC CCSDS OEM trajectory data for Artemis II
// Parses the OEM file once at module load, provides O(log n) interpolation.

import rawOem from "../Artemis_II_OEM_2026_04_04_to_EI.asc?raw";
import * as THREE from "three";

// ─── Constants ─────────────────────────────────────────────────────────────
export const R_EARTH = 6371;      // km — 1 scene unit
const SCALE = 1 / R_EARTH;

// Moon direction derived from the "lunar close approach" OEM point (MET 121.39 h):
//   2026-04-07T01:57:51  spacecraft pos=(-133823, -339699, -187562) km  r=410,467 km
// Moon is in the same direction as the spacecraft but at 384,400 km from Earth.
// Validated: min trajectory-to-Moon distance = 3,463 km (outside 1,737 km Moon radius).
const MOON_EME_X = -133823;
const MOON_EME_Y = -339699;
const MOON_EME_Z = -187562;
const MOON_EME_R  = 410467;   // spacecraft Earth distance at close approach

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

    const utcMs = new Date(p[0]).getTime();
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

// ─── Trajectory points for 3D curve (subsampled) ──────────────────────────
// Returns N Three.js Vector3 positions, time-uniformly spaced along the OEM.
export function getTrajectoryPoints(n = 400): THREE.Vector3[] {
  if (_sv.length === 0) return [];
  const step = Math.max(1, (_sv.length - 1) / (n - 1));
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(_sv.length - 1, Math.round(i * step));
    const sv = _sv[idx];
    out.push(eme2000ToThree(sv.x, sv.y, sv.z));
  }
  return out;
}

// ─── Moon position ─────────────────────────────────────────────────────────
// Place Moon at its approximate direction during the mission (from max-distance
// position in OEM data), at the correct Earth-Moon distance.
export function getMoonPosition(): THREE.Vector3 {
  // Scale the close-approach spacecraft position from 410,467 km → 384,400 km
  // to get the Moon's EME2000 position, then convert to Three.js scene units.
  const moonDistKm = 384400;
  const frac = moonDistKm / MOON_EME_R;
  return eme2000ToThree(MOON_EME_X * frac, MOON_EME_Y * frac, MOON_EME_Z * frac);
}

// ─── OEM metadata ──────────────────────────────────────────────────────────
export function getEphemerisRange(): { startMs: number; endMs: number; count: number } {
  return {
    startMs: _sv.length > 0 ? _sv[0].utcMs          : 0,
    endMs:   _sv.length > 0 ? _sv[_sv.length-1].utcMs : 0,
    count:   _sv.length,
  };
}

// OEM_START_MET and OEM_END_MET in hours from LAUNCH
// These are used by orbit-scene to set up the curve parameterisation.
// Launch: 2026-04-01T22:35:12Z
const LAUNCH_MS = new Date("2026-04-01T22:35:12Z").getTime();
export const OEM_START_MET_H = _sv.length > 0 ? (_sv[0].utcMs          - LAUNCH_MS) / 3600000 : 0;
export const OEM_END_MET_H   = _sv.length > 0 ? (_sv[_sv.length-1].utcMs - LAUNCH_MS) / 3600000 : 217.767;
