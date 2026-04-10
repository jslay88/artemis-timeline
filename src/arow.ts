// arow.ts — Live AROW telemetry from the artemis.cdnspace.ca community relay.
// Connects via SSE to /api/telemetry/stream and stores the latest snapshot of
// each event type with a receive timestamp for freshness checks.

const API_BASE = "https://artemis.cdnspace.ca";

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

let _es: EventSource | null = null;
let _connected = false;

let _orbit: Stamped<ArowOrbit> | null = null;
let _stateVector: Stamped<ArowStateVector> | null = null;
let _moonPosition: Stamped<{ x: number; y: number; z: number }> | null = null;
let _attitude: Stamped<ArowAttitude> | null = null;
let _dsn: Stamped<ArowDsn> | null = null;
let _solar: Stamped<ArowSolar> | null = null;

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

export function getAttitude(maxAgeMs = 5_000): ArowAttitude | null {
  return isFresh(_attitude, maxAgeMs) ? _attitude.data : null;
}

export function getDsn(maxAgeMs = 30_000): ArowDsn | null {
  return isFresh(_dsn, maxAgeMs) ? _dsn.data : null;
}

export function getSolar(maxAgeMs = 120_000): ArowSolar | null {
  return isFresh(_solar, maxAgeMs) ? _solar.data : null;
}

export function isConnected(): boolean {
  return _connected;
}

// ─── SSE Connection ─────────────────────────────────────────────────────────

export function connect(): void {
  if (_es) return;

  _es = new EventSource(`${API_BASE}/api/telemetry/stream`);

  _es.addEventListener("open", () => {
    _connected = true;
  });

  _es.addEventListener("error", () => {
    _connected = false;
  });

  _es.addEventListener("telemetry", (e: MessageEvent) => {
    try {
      const d = JSON.parse(e.data);
      const now = Date.now();

      if (d.telemetry) {
        _orbit = { data: d.telemetry as ArowOrbit, receivedAt: now };
      }
      if (d.stateVector) {
        _stateVector = { data: d.stateVector as ArowStateVector, receivedAt: now };
      }
      if (d.moonPosition) {
        _moonPosition = { data: d.moonPosition, receivedAt: now };
      }
    } catch { /* malformed JSON — skip */ }
  });

  _es.addEventListener("arow", (e: MessageEvent) => {
    try {
      const d = JSON.parse(e.data);
      _attitude = {
        data: {
          quaternion: d.quaternion ?? { w: 0, x: 0, y: 0, z: 0 },
          eulerDeg: d.eulerDeg ?? { roll: 0, pitch: 0, yaw: 0 },
          rollRate: d.rollRate ?? 0,
          pitchRate: d.pitchRate ?? 0,
          yawRate: d.yawRate ?? 0,
          sawAngles: d.sawAngles ?? { saw1: 0, saw2: 0, saw3: 0, saw4: 0 },
          spacecraftMode: d.spacecraftMode ?? "",
        },
        receivedAt: Date.now(),
      };
    } catch { /* skip */ }
  });

  _es.addEventListener("dsn", (e: MessageEvent) => {
    try {
      const d = JSON.parse(e.data);
      _dsn = { data: d as ArowDsn, receivedAt: Date.now() };
    } catch { /* skip */ }
  });

  _es.addEventListener("solar", (e: MessageEvent) => {
    try {
      const d = JSON.parse(e.data);
      _solar = { data: d as ArowSolar, receivedAt: Date.now() };
    } catch { /* skip */ }
  });
}

export function disconnect(): void {
  if (_es) {
    _es.close();
    _es = null;
    _connected = false;
  }
}
