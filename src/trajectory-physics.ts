// trajectory-physics.ts
// Real Keplerian orbital mechanics for Artemis II free-return trajectory.
// Uses patched-conic approximation: Earth-centered ellipses for trans-lunar
// and trans-Earth coasts, Moon-centered hyperbola for the lunar flyby.

// ─── Physical Constants ────────────────────────────────────────────────────
const MU_EARTH = 398600.4418; // km³/s²
const MU_MOON  = 4902.8;      // km³/s²
const R_EARTH  = 6371;        // km
const R_MOON   = 1737;        // km
const D_MOON   = 384400;      // km (Earth center → Moon center)
const SOI_MOON = 66100;       // km from Moon center

// ─── Mission Timeline (MET hours) ─────────────────────────────────────────
const T_TLI          = 25.617;   // Trans-Lunar Injection
const T_SOI_ENTRY    = 103.983;  // Enter Moon SOI
const T_PERICYNTHION = 121.39;   // Closest lunar approach
const T_SOI_EXIT     = 139.78;   // Exit Moon SOI
const T_ENTRY_IF     = 217.55;   // Entry Interface (EI)
const T_SPLASHDOWN   = 217.767;  // Splashdown

// ─── Orbit Parameters ─────────────────────────────────────────────────────

// Parking orbit (LEO)
const R_LEO = R_EARTH + 185; // 6556 km

// Trans-lunar transfer ellipse (Earth-centered)
// Periapsis = LEO, apoapsis ≈ near Moon pericynthion
const R_PERI_MOON_EARTH = D_MOON - (R_MOON + 110); // ≈ 382553 km
const A_TRANSFER = (R_LEO + R_PERI_MOON_EARTH) / 2; // ≈ 194555 km
const E_TRANSFER = 1 - R_LEO / A_TRANSFER;          // ≈ 0.9663
const N_TRANSFER = Math.sqrt(MU_EARTH / Math.pow(A_TRANSFER, 3)); // rad/s

// Trans-Earth return ellipse (Earth-centered)
// Apoapsis ≈ SOI exit distance from Earth, periapsis = entry interface
const R_SOI_EARTH = D_MOON - SOI_MOON; // ≈ 318300 km
const R_ENTRY     = R_EARTH + 120;      // ≈ 6491 km (Entry Interface altitude)
const A_RETURN    = (R_SOI_EARTH + R_ENTRY) / 2; // ≈ 162395 km
const E_RETURN    = (R_SOI_EARTH - R_ENTRY) / (R_SOI_EARTH + R_ENTRY);
const N_RETURN    = Math.sqrt(MU_EARTH / Math.pow(A_RETURN, 3)); // rad/s

// Moon SOI hyperbola parameters (Moon-centered)
// v_inf at SOI entry (relative to Moon)
const V_MOON_ORBIT = Math.sqrt(MU_EARTH / D_MOON); // ≈ 1.022 km/s
// Speed relative to Earth at SOI entry:
const V_AT_SOI_ENTRY = Math.sqrt(MU_EARTH * (2 / R_SOI_EARTH - 1 / A_TRANSFER));
// v_∞ relative to Moon (simplified: difference of speeds along radial direction)
const V_INF_MOON = Math.abs(V_AT_SOI_ENTRY - V_MOON_ORBIT); // ≈ 0.8 km/s
// Moon-centered hyperbolic orbit: C3 = v_inf²
const C3_MOON = V_INF_MOON * V_INF_MOON;

// ─── Kepler Solver (Halley's Method) ──────────────────────────────────────
// Solves M = E - e*sin(E) for eccentric anomaly E.
// Uses Halley's method for fast convergence at high eccentricity (e ≈ 0.966).
function solveKepler(M: number, e: number): number {
  // Good initial guess: avoids convergence issues near apoapsis
  let E = M < Math.PI ? M + e / 2 : M - e / 2;
  for (let i = 0; i < 8; i++) {
    const sinE = Math.sin(E);
    const cosE = Math.cos(E);
    const f   = E - e * sinE - M;
    const fp  = 1 - e * cosE;
    const fpp = e * sinE;
    const dE  = f / (fp - 0.5 * f * fpp / fp);
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

// ─── Phase Calculations ────────────────────────────────────────────────────

function parkingOrbit(): { r: number; v: number } {
  return {
    r: R_LEO,
    v: Math.sqrt(MU_EARTH / R_LEO), // circular orbit speed ≈ 7.79 km/s
  };
}

function transLunarCoast(metHours: number): { r: number; v: number } {
  const dt = (metHours - T_TLI) * 3600; // seconds since TLI
  const M  = N_TRANSFER * dt;           // mean anomaly (starts at 0 = periapsis)
  const E  = solveKepler(M, E_TRANSFER);
  const r  = A_TRANSFER * (1 - E_TRANSFER * Math.cos(E));
  const v  = Math.sqrt(MU_EARTH * (2 / r - 1 / A_TRANSFER));
  return { r, v };
}

function lunarSOI(metHours: number): { r: number; v: number } {
  // Interpolate r linearly from SOI entry to pericynthion to SOI exit
  // For speed: use Moon-centered hyperbola via vis-viva in Moon SOI
  const tTotal = T_SOI_EXIT - T_SOI_ENTRY;
  const tHalf  = T_PERICYNTHION - T_SOI_ENTRY;
  const t      = metHours - T_SOI_ENTRY;

  let r_moon: number; // distance from Moon center
  if (t <= tHalf) {
    // Approaching pericynthion
    const frac = t / tHalf;
    r_moon = SOI_MOON + (R_MOON + 110 - SOI_MOON) * (frac * frac * (3 - 2 * frac));
  } else {
    // Receding from pericynthion
    const frac = (t - tHalf) / (tTotal - tHalf);
    r_moon = (R_MOON + 110) + (SOI_MOON - R_MOON - 110) * (frac * frac * (3 - 2 * frac));
  }

  // Speed in Moon's reference frame via vis-viva on hyperbola: v² = C3 + 2μ/r
  const v_moon_frame = Math.sqrt(C3_MOON + 2 * MU_MOON / r_moon);
  // Distance from Earth: r ≈ D_MOON - r_moon (on approach) or +(on departure)
  const r_earth = t < tHalf
    ? D_MOON - r_moon
    : D_MOON - r_moon;

  return { r: Math.max(r_earth, R_EARTH + 50), v: v_moon_frame };
}

function transEarthCoast(metHours: number): { r: number; v: number } {
  // Return ellipse: starts at apoapsis (r ≈ R_SOI_EARTH), ends at periapsis (r = R_ENTRY)
  // Time since SOI exit
  const dt = (metHours - T_SOI_EXIT) * 3600;
  // Mean motion from apoapsis: M_apo = π at t=0 (apoapsis = half period)
  const M = Math.PI + N_RETURN * dt;
  const E = solveKepler(M % (2 * Math.PI), E_RETURN);
  const r = A_RETURN * (1 - E_RETURN * Math.cos(E));
  const v = Math.sqrt(MU_EARTH * (2 / r - 1 / A_RETURN));
  return { r, v };
}

function entryDescent(metHours: number): { r: number; v: number } {
  // EDL: 13 minutes from EI (120 km alt, ~11 km/s) to splashdown (0 km, 0 km/s)
  const frac = (metHours - T_ENTRY_IF) / (T_SPLASHDOWN - T_ENTRY_IF);
  const t    = Math.min(Math.max(frac, 0), 1);
  // Altitude: rapid deceleration curve
  const alt  = (1 - t) * (1 - t) * 120; // km above surface
  // Speed: starts high, decelerates with parachutes at ~5 km
  const v_ei = Math.sqrt(MU_EARTH * (2 / R_ENTRY - 1 / A_RETURN));
  const v    = v_ei * Math.pow(1 - t, 0.6) * (1 - 0.4 * Math.max(0, (t - 0.85) / 0.15));
  return { r: R_EARTH + alt, v: Math.max(v, 0) };
}

// ─── Smooth Blend at Phase Boundaries ─────────────────────────────────────
function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

function blendStates(
  a: { r: number; v: number },
  b: { r: number; v: number },
  t: number
): { r: number; v: number } {
  const s = smoothStep(Math.min(Math.max(t, 0), 1));
  return { r: a.r + (b.r - a.r) * s, v: a.v + (b.v - a.v) * s };
}

// ─── Public Interface ──────────────────────────────────────────────────────

export interface OrbitalState {
  distanceFromEarth: number;  // km from Earth center
  altitudeAboveEarth: number; // km above surface
  speed: number;              // km/s
  phase: string;
}

export function sampleOrionTelemetry(metHours: number): OrbitalState {
  const BLEND = 1.0; // hours for smooth transitions at phase boundaries

  let state: { r: number; v: number };
  let phase: string;

  if (metHours < T_TLI) {
    // Parking orbit / ascent
    state = parkingOrbit();
    phase = "Parking Orbit";
  } else if (metHours < T_SOI_ENTRY) {
    // Trans-lunar coast
    const raw = transLunarCoast(metHours);
    if (metHours < T_TLI + BLEND) {
      // Blend from parking orbit to TLI speed
      const tli_state = { r: R_LEO, v: Math.sqrt(MU_EARTH / R_LEO) + 3.15 };
      const t = (metHours - T_TLI) / BLEND;
      state = blendStates(tli_state, raw, t);
    } else {
      state = raw;
    }
    phase = "Trans-Lunar Coast";
  } else if (metHours < T_SOI_EXIT) {
    // Lunar SOI
    const raw = lunarSOI(metHours);
    if (metHours < T_SOI_ENTRY + BLEND) {
      const prev = transLunarCoast(T_SOI_ENTRY - 0.01);
      const t = (metHours - T_SOI_ENTRY) / BLEND;
      state = blendStates(prev, raw, t);
    } else if (metHours > T_SOI_EXIT - BLEND) {
      const next = transEarthCoast(T_SOI_EXIT + 0.01);
      const t = (metHours - (T_SOI_EXIT - BLEND)) / BLEND;
      state = blendStates(raw, next, t);
    } else {
      state = raw;
    }
    phase = metHours < T_PERICYNTHION ? "Lunar Approach" : "Trans-Earth Injection";
  } else if (metHours < T_ENTRY_IF) {
    // Trans-Earth coast
    const raw = transEarthCoast(metHours);
    if (metHours < T_SOI_EXIT + BLEND) {
      const prev = lunarSOI(T_SOI_EXIT - 0.01);
      const t = (metHours - T_SOI_EXIT) / BLEND;
      state = blendStates(prev, raw, t);
    } else {
      state = raw;
    }
    phase = "Trans-Earth Coast";
  } else {
    // Entry, Descent, Landing
    state = entryDescent(metHours);
    phase = "Entry & Descent";
  }

  const altitude = Math.max(state.r - R_EARTH, 0);
  return {
    distanceFromEarth:  state.r,
    altitudeAboveEarth: altitude,
    speed:              state.v,
    phase,
  };
}

// ─── Precomputed Table for Charts ─────────────────────────────────────────

export interface TelemetryTable {
  metHours:  Float64Array;
  speed:     Float64Array;
  distance:  Float64Array;
  altitude:  Float64Array;
  count:     number;
}

export function buildTelemetryTable(sampleCount = 1000): TelemetryTable {
  const metHours = new Float64Array(sampleCount);
  const speed    = new Float64Array(sampleCount);
  const distance = new Float64Array(sampleCount);
  const altitude = new Float64Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const t = (i / (sampleCount - 1)) * T_SPLASHDOWN;
    const s = sampleOrionTelemetry(t);
    metHours[i] = t;
    speed[i]    = s.speed;
    distance[i] = s.distanceFromEarth;
    altitude[i] = s.altitudeAboveEarth;
  }

  return { metHours, speed, distance, altitude, count: sampleCount };
}
