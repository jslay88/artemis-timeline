// arow.ts — Live AROW telemetry from the artemis.cdnspace.ca community relay.
// Uses REST polling through a CORS proxy. Each endpoint is polled at its
// natural cadence: attitude 2s, DSN 15s, orbit 30s, solar 120s.

const PROXY_BASE = import.meta.env.VITE_AROW_PROXY ?? "https://artemis-arow-proxy.jslay.workers.dev";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ArowOrbit {
  metMs: number;
  speedKmS: number;
  speedKmH: number;
  moonRelSpeedKmH: number;
  altitudeKm: number;
  earthDistKm: number;
  moonDistKm: number;
  gForce: number;
  periapsisKm: number;
  apoapsisKm: number;
}

export interface ArowStateVector {
  timestamp: string;
  metMs: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
}

export interface ArowAttitude {
  quaternion: { w: number; x: number; y: number; z: number };
  eulerDeg: { roll: number; pitch: number; yaw: number };
  rollRate: number;
  pitchRate: number;
  yawRate: number;
  sawAngles: { saw1: number; saw2: number; saw3: number; saw4: number };
  spacecraftMode: string;
}

export interface ArowDsnDish {
  dish: string;
  station: string;
  stationName: string;
  azimuth: number;
  elevation: number;
  downlinkActive: boolean;
  downlinkRate: number;
  downlinkBand: string;
  uplinkActive: boolean;
  uplinkRate: number;
  uplinkBand: string;
  rangeKm: number;
  rtltSeconds: number;
}

export interface ArowDsn {
  dishes: ArowDsnDish[];
  signalActive: boolean;
}

export interface ArowSolar {
  kpIndex: number;
  kpLabel: string;
  xrayFlux: number;
  xrayClass: string;
  protonFlux10MeV: number;
  radiationRisk: string;
}

interface Stamped<T> {
  data: T;
  receivedAt: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

let _connected = false;
let _timers: ReturnType<typeof setInterval>[] = [];

let _orbit: Stamped<ArowOrbit> | null = null;
let _stateVector: Stamped<ArowStateVector> | null = null;
let _moonPosition: Stamped<{ x: number; y: number; z: number }> | null = null;
let _attitude: Stamped<ArowAttitude> | null = null;
let _dsn: Stamped<ArowDsn> | null = null;
let _solar: Stamped<ArowSolar> | null = null;

let _lastSuccess = 0;
const CONNECTED_WINDOW_MS = 30_000;

// ─── Freshness helpers ──────────────────────────────────────────────────────

function isFresh<T>(s: Stamped<T> | null, maxAgeMs: number): s is Stamped<T> {
  return s !== null && (Date.now() - s.receivedAt) < maxAgeMs;
}

// ─── Public getters ─────────────────────────────────────────────────────────

export function getOrbit(maxAgeMs = 600_000): ArowOrbit | null {
  return isFresh(_orbit, maxAgeMs) ? _orbit.data : null;
}

export function getStateVector(maxAgeMs = 600_000): ArowStateVector | null {
  return isFresh(_stateVector, maxAgeMs) ? _stateVector.data : null;
}

export function getMoonPositionLive(maxAgeMs = 600_000): { x: number; y: number; z: number } | null {
  return isFresh(_moonPosition, maxAgeMs) ? _moonPosition.data : null;
}

export function getAttitude(maxAgeMs = 120_000): ArowAttitude | null {
  return isFresh(_attitude, maxAgeMs) ? _attitude.data : null;
}

export function getDsn(maxAgeMs = 120_000): ArowDsn | null {
  return isFresh(_dsn, maxAgeMs) ? _dsn.data : null;
}

export function getSolar(maxAgeMs = 300_000): ArowSolar | null {
  return isFresh(_solar, maxAgeMs) ? _solar.data : null;
}

export function isConnected(): boolean {
  return _connected;
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────

const RETRY_DELAY_MS = 10_000;

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${PROXY_BASE}${path}`);
    if (resp.status === 502) {
      await delay(RETRY_DELAY_MS);
      const retry = await fetch(`${PROXY_BASE}${path}`);
      if (!retry.ok) return null;
      _lastSuccess = Date.now();
      _connected = true;
      return await retry.json() as T;
    }
    if (!resp.ok) return null;
    _lastSuccess = Date.now();
    _connected = true;
    return await resp.json() as T;
  } catch {
    if (Date.now() - _lastSuccess > CONNECTED_WINDOW_MS) _connected = false;
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Sequential poll loop ───────────────────────────────────────────────────
// One request at a time, 2s gap between each, full cycle ~once per minute.

const POLL_GAP_MS = 2_000;
let _running = false;

async function pollLoop(): Promise<void> {
  if (_running) return;
  _running = true;

  while (_timers.length > 0) {
    // Attitude
    const arowData = await fetchJson<Record<string, unknown>>("/api/arow");
    if (arowData) {
      _attitude = {
        data: {
          quaternion: (arowData.quaternion as ArowAttitude["quaternion"]) ?? { w: 0, x: 0, y: 0, z: 0 },
          eulerDeg: (arowData.eulerDeg as ArowAttitude["eulerDeg"]) ?? { roll: 0, pitch: 0, yaw: 0 },
          rollRate: (arowData.rollRate as number) ?? 0,
          pitchRate: (arowData.pitchRate as number) ?? 0,
          yawRate: (arowData.yawRate as number) ?? 0,
          sawAngles: (arowData.sawAngles as ArowAttitude["sawAngles"]) ?? { saw1: 0, saw2: 0, saw3: 0, saw4: 0 },
          spacecraftMode: (arowData.spacecraftMode as string) ?? "",
        },
        receivedAt: Date.now(),
      };
    }
    await delay(POLL_GAP_MS);

    // Orbit
    const orbitData = await fetchJson<ArowOrbit>("/api/orbit");
    if (orbitData) _orbit = { data: orbitData, receivedAt: Date.now() };
    await delay(POLL_GAP_MS);

    // State vectors
    const stateData = await fetchJson<{ stateVector: ArowStateVector; moonPosition: { x: number; y: number; z: number } }>("/api/state");
    if (stateData) {
      const now = Date.now();
      if (stateData.stateVector) _stateVector = { data: stateData.stateVector, receivedAt: now };
      if (stateData.moonPosition) _moonPosition = { data: stateData.moonPosition, receivedAt: now };
    }
    await delay(POLL_GAP_MS);

    // DSN
    const dsnData = await fetchJson<ArowDsn>("/api/dsn");
    if (dsnData) _dsn = { data: dsnData, receivedAt: Date.now() };
    await delay(POLL_GAP_MS);

    // Solar
    const solarData = await fetchJson<ArowSolar>("/api/solar");
    if (solarData) _solar = { data: solarData, receivedAt: Date.now() };

    // Pad the remainder to ~60s total cycle
    await delay(50_000);
  }

  _running = false;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function connect(): void {
  if (_timers.length > 0) return;
  _timers.push(0 as unknown as ReturnType<typeof setInterval>);
  pollLoop();
}

export function disconnect(): void {
  for (const t of _timers) clearInterval(t);
  _timers = [];
  _connected = false;
}
