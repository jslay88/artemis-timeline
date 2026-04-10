// arow.ts — Live telemetry from NASA's AROW ground system.
// Attitude data is fetched directly from NASA's GCS bucket (via our CORS
// proxy). Computed orbital, DSN, and solar data come from the community
// relay's /api/all endpoint as a fallback source.
// Two requests per ~60s cycle, fully sequential, no bursts.

const PROXY_BASE = import.meta.env.VITE_AROW_PROXY ?? "https://artemis-arow-proxy.jslay.workers.dev";

const RAD2DEG = 180 / Math.PI;

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
const CONNECTED_WINDOW_MS = 120_000;

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

// ─── GCS raw parameter parsing ──────────────────────────────────────────────
// Parameter numbers from AROW Unity IL2CPP metadata (OnlineParameters class).

function param(raw: Record<string, RawParam>, num: number): number {
  const p = raw[`Parameter_${num}`];
  if (!p || p.Status !== "Good") return 0;
  return parseFloat(p.Value);
}

interface RawParam {
  Status: string;
  Value: string;
  Type: string;
}

function paramHex(raw: Record<string, RawParam>, num: number): string {
  const p = raw[`Parameter_${num}`];
  if (!p || p.Status !== "Good") return "";
  return p.Value;
}

function parseGcsOrion(raw: Record<string, RawParam>): void {
  const now = Date.now();

  _attitude = {
    data: {
      quaternion: {
        w: param(raw, 2074),
        x: param(raw, 2075),
        y: param(raw, 2076),
        z: param(raw, 2077),
      },
      eulerDeg: {
        roll:  param(raw, 2080) * RAD2DEG,
        pitch: param(raw, 2078) * RAD2DEG,
        yaw:   param(raw, 2079) * RAD2DEG,
      },
      rollRate:  param(raw, 2091) * RAD2DEG,
      pitchRate: param(raw, 2092) * RAD2DEG,
      yawRate:   param(raw, 2093) * RAD2DEG,
      sawAngles: {
        saw1: param(raw, 5006),
        saw2: param(raw, 5007),
        saw3: param(raw, 5008),
        saw4: param(raw, 5009),
      },
      spacecraftMode: paramHex(raw, 2016),
    },
    receivedAt: now,
  };
}

// ─── Sequential poll loop ───────────────────────────────────────────────────
// Two requests per ~60s cycle: GCS for raw attitude, relay /api/all for the rest.

let _running = false;

async function pollLoop(): Promise<void> {
  if (_running) return;
  _running = true;

  while (_timers.length > 0) {
    // 1. Attitude from NASA GCS (direct, reliable)
    const gcs = await fetchJson<Record<string, RawParam>>("/gcs/orion");
    if (gcs) parseGcsOrion(gcs);

    await delay(30_000);

    // 2. Computed orbital, DSN, solar from community relay
    const all = await fetchJson<{
      telemetry?: ArowOrbit;
      stateVector?: ArowStateVector;
      moonPosition?: { x: number; y: number; z: number };
      dsn?: ArowDsn;
    }>("/api/all");

    if (all) {
      const now = Date.now();
      if (all.telemetry)    _orbit       = { data: all.telemetry,    receivedAt: now };
      if (all.stateVector)  _stateVector = { data: all.stateVector,  receivedAt: now };
      if (all.moonPosition) _moonPosition = { data: all.moonPosition, receivedAt: now };
      if (all.dsn)          _dsn         = { data: all.dsn,          receivedAt: now };
    }

    // Solar is on its own endpoint (not in /api/all)
    const solar = await fetchJson<ArowSolar>("/api/solar");
    if (solar) _solar = { data: solar, receivedAt: Date.now() };

    await delay(30_000);
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
