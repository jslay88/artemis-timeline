// ephemeris.ts — Real NASA/JSC CCSDS OEM trajectory data for Artemis II
// Parses the OEM file once at module load, provides O(log n) interpolation.

import rawOem from "../Artemis_II_OEM_2026_04_10_Post-ICPS-Sep-to-EI.asc?raw";
import * as THREE from "three";

// ─── Constants ─────────────────────────────────────────────────────────────
export const R_EARTH = 6371;      // km — 1 scene unit
export const R_MOON  = 1737.4;   // km
const SCALE = 1 / R_EARTH;
const LAUNCH_MS = new Date("2026-04-01T22:35:12Z").getTime();

const LUNAR_SOI_ENTRY_MET_H = 102.074;
const LUNAR_SOI_EXIT_MET_H  = 138.809;

// Moon EME2000/ICRF positions from JPL DE441 ephemeris (Horizons API),
// every 6 hours for the full mission. Linearly interpolated at runtime.
// [utcMs offset from LAUNCH, x_km, y_km, z_km]
const MOON_LUT: [number, number, number, number][] = [
  [5088000, -385834, -60039, -46891],       // MET 1.4h
  [26688000, -381940, -78885, -56873],      // MET 7.4h
  [48288000, -376886, -97492, -66680],      // MET 13.4h
  [69888000, -370694, -115803, -76285],     // MET 19.4h
  [91488000, -363392, -133765, -85659],     // MET 25.4h
  [113088000, -355008, -151325, -94774],    // MET 31.4h
  [134688000, -345572, -168434, -103606],   // MET 37.4h
  [156288000, -335121, -185041, -112129],   // MET 43.4h
  [177888000, -323690, -201101, -120319],   // MET 49.4h
  [199488000, -311318, -216569, -128154],   // MET 55.4h
  [221088000, -298046, -231401, -135612],   // MET 61.4h
  [242688000, -283917, -245559, -142674],   // MET 67.4h
  [264288000, -268977, -259002, -149321],   // MET 73.4h
  [285888000, -253271, -271696, -155535],   // MET 79.4h
  [307488000, -236847, -283606, -161299],   // MET 85.4h
  [329088000, -219756, -294700, -166599],   // MET 91.4h
  [350688000, -202048, -304949, -171421],   // MET 97.4h
  [372288000, -183774, -314327, -175752],   // MET 103.4h
  [393888000, -164989, -322807, -179581],   // MET 109.4h
  [415488000, -145745, -330367, -182898],   // MET 115.4h
  [437088000, -126098, -336987, -185693],   // MET 121.4h
  [458688000, -106103, -342649, -187961],   // MET 127.4h
  [480288000, -85817, -347337, -189694],    // MET 133.4h
  [501888000, -65297, -351037, -190886],    // MET 139.4h
  [523488000, -44600, -353737, -191536],    // MET 145.4h
  [545088000, -23784, -355430, -191639],    // MET 151.4h
  [566688000, -2908, -356107, -191194],     // MET 157.4h
  [588288000, 17970, -355765, -190202],     // MET 163.4h
  [609888000, 38790, -354402, -188663],     // MET 169.4h
  [631488000, 59493, -352016, -186581],     // MET 175.4h
  [653088000, 80020, -348612, -183959],     // MET 181.4h
  [674688000, 100311, -344194, -180801],    // MET 187.4h
  [696288000, 120307, -338770, -177114],    // MET 193.4h
  [717888000, 139947, -332349, -172907],    // MET 199.4h
  [739488000, 159174, -324944, -168187],    // MET 205.4h
  [761088000, 177927, -316569, -162966],    // MET 211.4h
  [782688000, 196148, -307244, -157256],    // MET 217.4h
];

function getMoonEME2000At(utcMs: number): { x: number; y: number; z: number } {
  const offset = utcMs - LAUNCH_MS;

  if (offset <= MOON_LUT[0][0])
    return { x: MOON_LUT[0][1], y: MOON_LUT[0][2], z: MOON_LUT[0][3] };

  const last = MOON_LUT[MOON_LUT.length - 1];
  if (offset >= last[0])
    return { x: last[1], y: last[2], z: last[3] };

  let lo = 0, hi = MOON_LUT.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (MOON_LUT[mid][0] <= offset) lo = mid; else hi = mid - 1;
  }

  const a = MOON_LUT[lo];
  const b = MOON_LUT[lo + 1];
  const t = (offset - a[0]) / (b[0] - a[0]);

  return {
    x: a[1] + t * (b[1] - a[1]),
    y: a[2] + t * (b[2] - a[2]),
    z: a[3] + t * (b[3] - a[3]),
  };
}

// Closest-approach Moon position for 3D scene rendering (MET ~120.5h)
const MOON_SCENE_EME = getMoonEME2000At(LAUNCH_MS + 120.461 * 3600000);

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
  distanceFromMoon: number;    // km (from Moon center)
  altitude: number;            // km (above surface of SOI body)
  altitudeBody: "earth" | "moon";
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

// ─── Pre-OEM backward propagation ──────────────────────────────────────────
// The OEM starts at MET +3.37h (post-TLI), missing the launch-to-TLI segment.
// Backward-propagate the first OEM state under Earth-only gravity (Velocity
// Verlet) to fill the gap with a physically correct elliptical departure arc.
const GM_EARTH = 398600.4418; // km³/s²

(function prependPreOemStates(): void {
  if (_sv.length === 0) return;
  const sv0 = _sv[0];
  const gapMs = sv0.utcMs - LAUNCH_MS;
  if (gapMs <= 0) return;

  let px = sv0.x, py = sv0.y, pz = sv0.z;
  let vx = sv0.vx, vy = sv0.vy, vz = sv0.vz;
  const DT = 30; // seconds per integration step
  const totalSteps = Math.floor(gapMs / (DT * 1000));
  const OUTPUT_INTERVAL = 8; // emit a state every 8 steps (~4 min)
  const MIN_R = R_EARTH + 180; // stop above parking-orbit altitude

  const prepend: StateVector[] = [];

  for (let step = 1; step <= totalSteps; step++) {
    // Velocity Verlet backward step
    let r2 = px * px + py * py + pz * pz;
    let r  = Math.sqrt(r2);
    let f  = -GM_EARTH / (r2 * r);
    let ax = f * px, ay = f * py, az = f * pz;

    const vxh = vx - 0.5 * ax * DT;
    const vyh = vy - 0.5 * ay * DT;
    const vzh = vz - 0.5 * az * DT;

    px -= vxh * DT;
    py -= vyh * DT;
    pz -= vzh * DT;

    r2 = px * px + py * py + pz * pz;
    r  = Math.sqrt(r2);
    if (r <= MIN_R) break;

    f  = -GM_EARTH / (r2 * r);
    ax = f * px; ay = f * py; az = f * pz;

    vx = vxh - 0.5 * ax * DT;
    vy = vyh - 0.5 * ay * DT;
    vz = vzh - 0.5 * az * DT;

    if (step % OUTPUT_INTERVAL === 0) {
      prepend.push({
        utcMs: sv0.utcMs - step * DT * 1000,
        x: px, y: py, z: pz,
        vx, vy, vz,
      });
    }
  }

  // Add a final point on Earth's surface for the very start (launch)
  const lastPre = prepend.length > 0 ? prepend[prepend.length - 1] : sv0;
  const rLast = Math.sqrt(lastPre.x ** 2 + lastPre.y ** 2 + lastPre.z ** 2);
  const surfScale = R_EARTH / rLast;
  prepend.push({
    utcMs: LAUNCH_MS,
    x: lastPre.x * surfScale,
    y: lastPre.y * surfScale,
    z: lastPre.z * surfScale,
    vx: lastPre.vx,
    vy: lastPre.vy,
    vz: lastPre.vz,
  });

  // Reverse (they were generated newest-first) and prepend to _sv
  prepend.reverse();
  _sv.unshift(...prepend);
})();

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

  const metH = (utcMs - LAUNCH_MS) / 3600000;
  const inLunarSOI = metH >= LUNAR_SOI_ENTRY_MET_H && metH <= LUNAR_SOI_EXIT_MET_H;

  let altitude: number;
  let altitudeBody: "earth" | "moon";

  const moon = getMoonEME2000At(utcMs);
  const mdx = sv.x - moon.x;
  const mdy = sv.y - moon.y;
  const mdz = sv.z - moon.z;
  const distanceFromMoon = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);

  if (inLunarSOI) {
    altitude = distanceFromMoon - R_MOON;
    altitudeBody = "moon";
  } else {
    altitude = r - R_EARTH;
    altitudeBody = "earth";
  }

  return { speed, distanceFromEarth: r, distanceFromMoon, altitude, altitudeBody };
}

// ─── Trajectory points for 3D curve ──────────────────────────────────────
// Spans the FULL mission: Launch (MET 0) → Splashdown (MET 217.767h).
// Pre-OEM states are filled by backward Keplerian propagation (see above).
// Post-OEM segment (last data point → splashdown) is smoothly interpolated
// back to Earth's surface. Time-uniform sampling ensures curve parameter `t`
// maps linearly to MET.
const TOTAL_MET_H = 217.767;

export function getTrajectoryPoints(n = 800): THREE.Vector3[] {
  if (_sv.length === 0) return [];

  const missionStartMs = LAUNCH_MS;
  const missionEndMs   = LAUNCH_MS + TOTAL_MET_H * 3600000;
  const dataEndMs      = _sv[_sv.length - 1].utcMs;

  const lastData  = eme2000ToThree(
    _sv[_sv.length - 1].x, _sv[_sv.length - 1].y, _sv[_sv.length - 1].z,
  );
  const splashSurf = lastData.clone().normalize();

  const out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    const tMs  = missionStartMs + frac * (missionEndMs - missionStartMs);

    if (tMs > dataEndMs) {
      const f = (tMs - dataEndMs) / (missionEndMs - dataEndMs);
      const s = f * f * (3 - 2 * f);
      out.push(new THREE.Vector3().lerpVectors(lastData, splashSurf, s));
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
// Moon position for 3D scene rendering, fixed at closest approach epoch so
// the trajectory visually passes near the Moon sphere at the correct distance.
export function getMoonPosition(): THREE.Vector3 {
  return eme2000ToThree(MOON_SCENE_EME.x, MOON_SCENE_EME.y, MOON_SCENE_EME.z);
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
