import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import gsap from "gsap";
import { t } from "./i18n.ts";

/* ════════════════════════════════════════════
   Configuration
   ════════════════════════════════════════════ */

/*
 * True-scale body sizes and distance.
 *   Earth radius  ≈ 6 371 km   → 1 unit
 *   Moon radius   ≈ 1 737 km   → 0.2727 units  (0.273× Earth)
 *   Earth–Moon    ≈ 384 400 km  → 60.33 units   (60.3× Earth radius)
 */
const EARTH_RADIUS = 1;
const MOON_RADIUS = 0.2727;
const MOON_POS = new THREE.Vector3(60.33, 0, 0);
const TOTAL_MET_HOURS = 217.7667;
const SUN_DIR = new THREE.Vector3(1, 0.35, 0.5).normalize();

/*
 * Figure-8 (∞) trajectory — starts at TLI (Earth lobe apex).
 *
 * 24 control points with low tension for a smooth spline.
 * All sampling uses arc-length parametrization (getPointAt) so that
 * the time-based u maps to geometrically correct positions:
 * outbound ≈ 41% of arc, Moon lobe ≈ 18%, return ≈ 41%.
 */
const TLI_MET = 25.617;
const TRAJ_DURATION = TOTAL_MET_HOURS - TLI_MET;

const PATH_POINTS = [
  /* 0 — TLI / splashdown: Earth lobe apex */
  new THREE.Vector3(-2.5, 0, 0),

  /* 1–4 — Upper Earth arc → depart */
  new THREE.Vector3(-2, 2.5, 0.15),
  new THREE.Vector3(-0.5, 3.5, 0.25),
  new THREE.Vector3(1.5, 3.2, 0.2),
  new THREE.Vector3(4, 2.5, 0.1),

  /* 5–9 — Outbound transit (descending through crossing) */
  new THREE.Vector3(14, 1.5, 0.05),
  new THREE.Vector3(24, 0.5, 0),
  new THREE.Vector3(34, -0.5, 0),
  new THREE.Vector3(44, -1.5, -0.05),
  new THREE.Vector3(53, -2.5, -0.1),

  /* 10–14 — Moon lobe */
  new THREE.Vector3(58, -2, -0.1),
  new THREE.Vector3(61, -1, -0.05),
  new THREE.Vector3(62.8, 0, 0),
  new THREE.Vector3(61, 1, 0.05),
  new THREE.Vector3(58, 2, 0.1),

  /* 15–19 — Return transit (descending through crossing) */
  new THREE.Vector3(53, 2.5, 0.1),
  new THREE.Vector3(44, 1.5, 0.05),
  new THREE.Vector3(34, 0.5, 0),
  new THREE.Vector3(24, -0.5, 0),
  new THREE.Vector3(14, -1.5, -0.05),

  /* 20–23 — Lower Earth arc (wraps back to 0) */
  new THREE.Vector3(4, -2.5, -0.1),
  new THREE.Vector3(1.5, -3.2, -0.2),
  new THREE.Vector3(-0.5, -3.5, -0.25),
  new THREE.Vector3(-2, -2.5, -0.15),
];

const curve = new THREE.CatmullRomCurve3(PATH_POINTS, true, "catmullrom", 0.15);

/** Map mission MET-hours to curve parameter u (0 at TLI, 1 at splashdown). */
function metToU(metHours: number): number {
  return Math.min(1, Math.max(0, (metHours - TLI_MET) / TRAJ_DURATION));
}

interface Milestone {
  key: string;
  metHours: number;
  color: number;
}

const MILESTONES: Milestone[] = [
  { key: "ms.launch", metHours: 0, color: 0x4ade80 },
  { key: "ms.tli", metHours: 25.617, color: 0x60a5fa },
  { key: "ms.lunarSoi", metHours: 103.983, color: 0xa78bfa },
  { key: "ms.closeApproach", metHours: 121.39, color: 0xfbbf24 },
  { key: "ms.maxDistance", metHours: 121.45, color: 0xf59e0b },
  { key: "ms.soiExit", metHours: 139.78, color: 0xa78bfa },
  { key: "ms.splashdown", metHours: 217.767, color: 0xef4444 },
];

export function sampleCraftPosition(u: number): THREE.Vector3 {
  return curve.getPointAt(Math.min(1, Math.max(0, u)));
}

/* ════════════════════════════════════════════
   Shaders
   ════════════════════════════════════════════ */

const EARTH_NIGHT_VERT = `
varying vec2 vUv;
varying vec3 vNormalW;
void main() {
  vUv = uv;
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const EARTH_NIGHT_FRAG = `
uniform sampler2D nightTexture;
uniform vec3 sunDir;
varying vec2 vUv;
varying vec3 vNormalW;
void main() {
  float light = dot(vNormalW, sunDir);
  float nightFactor = smoothstep(0.15, -0.25, light);
  vec4 nightColor = texture2D(nightTexture, vUv);
  gl_FragColor = vec4(nightColor.rgb * nightFactor * 2.5, nightFactor * 0.85);
}`;

const ATM_VERT = `
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewPos = -mvPos.xyz;
  gl_Position = projectionMatrix * mvPos;
}`;

const ATM_FRAG = `
uniform vec3 glowColor;
uniform float intensity;
uniform float power;
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vec3 viewDir = normalize(vViewPos);
  float rim = 1.0 - max(0.0, dot(viewDir, vNormal));
  float glow = pow(rim, power) * intensity;
  gl_FragColor = vec4(glowColor, glow);
}`;

const TUBE_VERT = `
attribute float uParam;
varying float vU;
void main() {
  vU = uParam;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const TUBE_FRAG = `
uniform float progress;
varying float vU;
void main() {
  float t = 1.0 - smoothstep(progress - 0.012, progress + 0.012, vU);
  vec3 bright = vec3(0.243, 0.878, 1.0);
  vec3 dim = vec3(0.04, 0.1, 0.18);
  vec3 color = mix(dim, bright, t);
  float alpha = mix(0.12, 0.6, t);
  float pulse = 0.85 + 0.15 * sin(vU * 120.0 + progress * 40.0);
  alpha *= mix(1.0, pulse, t);
  gl_FragColor = vec4(color, alpha);
}`;

/* ════════════════════════════════════════════
   Orion Spacecraft
   ════════════════════════════════════════════ */

interface OrionCraft {
  group: THREE.Group;
  engineGlow: THREE.Mesh;
}

function buildOrion(): OrionCraft {
  const group = new THREE.Group();

  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xe8e8e8, metalness: 0.35, roughness: 0.45,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a3a, metalness: 0.75, roughness: 0.2,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xd4a843, metalness: 0.65, roughness: 0.28,
  });
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x162350, metalness: 0.2, roughness: 0.5,
    emissive: 0x0a1530, emissiveIntensity: 0.5,
  });

  const cm = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.4, 0.55, 20), whiteMat);
  cm.rotation.x = Math.PI / 2;
  cm.position.z = 0.58;
  group.add(cm);

  const shield = new THREE.Mesh(
    new THREE.CylinderGeometry(0.41, 0.41, 0.04, 20),
    darkMat
  );
  shield.rotation.x = Math.PI / 2;
  shield.position.z = 0.3;
  group.add(shield);

  const sm = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.8, 20), goldMat);
  sm.rotation.x = Math.PI / 2;
  sm.position.z = -0.1;
  group.add(sm);

  const panelGeo = new THREE.BoxGeometry(0.35, 0.012, 1.7);
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const panel = new THREE.Mesh(panelGeo, panelMat);
    panel.position.set(Math.cos(angle) * 1.1, Math.sin(angle) * 1.1, -0.1);
    panel.rotation.z = angle;
    group.add(panel);
  }

  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.22, 0.3, 14), darkMat);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.z = -0.65;
  group.add(nozzle);

  const engineGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x3ee0ff, transparent: true, opacity: 0.85 })
  );
  engineGlow.position.z = -0.73;
  group.add(engineGlow);

  group.scale.setScalar(0.25);
  return { group, engineGlow };
}

/* ════════════════════════════════════════════
   Particle trail behind spacecraft
   ════════════════════════════════════════════ */

interface TrailSystem {
  push: (pos: THREE.Vector3) => void;
  tick: () => void;
  dispose: () => void;
}

function createTrailSystem(scene: THREE.Scene): TrailSystem {
  const COUNT = 120;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(COUNT * 3);
  const alphas = new Float32Array(COUNT);
  const sizes = new Float32Array(COUNT);

  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("alpha", new THREE.BufferAttribute(alphas, 1));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(0x3ee0ff) },
      pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: `
      attribute float alpha;
      attribute float size;
      varying float vAlpha;
      uniform float pixelRatio;
      void main() {
        vAlpha = alpha;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * pixelRatio * (200.0 / -mvPos.z);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float a = smoothstep(0.5, 0.1, d) * vAlpha;
        gl_FragColor = vec4(color, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);

  let head = 0;

  function push(pos: THREE.Vector3): void {
    const i3 = head * 3;
    positions[i3] = pos.x;
    positions[i3 + 1] = pos.y;
    positions[i3 + 2] = pos.z;
    alphas[head] = 1.0;
    sizes[head] = 2.5;
    head = (head + 1) % COUNT;
  }

  function tick(): void {
    for (let i = 0; i < COUNT; i++) {
      alphas[i] *= 0.96;
      sizes[i] *= 0.985;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
  }

  return { push, tick, dispose: () => { geo.dispose(); mat.dispose(); } };
}

/* ════════════════════════════════════════════
   Stars with size variation
   ════════════════════════════════════════════ */

function createStars(count: number = 8000): THREE.Points {
  const geo = new THREE.BufferGeometry();
  const verts = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    verts[i3] = (Math.random() - 0.5) * 2000;
    verts[i3 + 1] = (Math.random() - 0.5) * 2000;
    verts[i3 + 2] = (Math.random() - 0.5) * 2000;
    const b = 0.4 + Math.random() * 0.6;
    const w = Math.random();
    colors[i3] = b * (0.85 + w * 0.15);
    colors[i3 + 1] = b * (0.88 + w * 0.12);
    colors[i3 + 2] = b;
    sizes[i] = Math.random() < 0.02 ? 2.5 + Math.random() * 2 : 0.4 + Math.random() * 1.2;
  }

  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      uniform float pixelRatio;
      void main() {
        vColor = color;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * pixelRatio * (300.0 / -mvPos.z);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float a = smoothstep(0.5, 0.05, d);
        gl_FragColor = vec4(vColor, a * 0.9);
      }
    `,
    transparent: true,
    vertexColors: true,
    depthWrite: false,
  });

  return new THREE.Points(geo, mat);
}

/* ════════════════════════════════════════════
   Main Scene
   ════════════════════════════════════════════ */

export interface OrbitClock {
  getProgress: () => number;
}

export interface OrbitSceneApi {
  resize: () => void;
  toggleFullscreen: () => void;
  flyTo: (target: THREE.Vector3) => void;
  updateLabels: () => void;
  dispose: () => void;
}

export function createOrbitScene(canvas: HTMLCanvasElement, clock: OrbitClock): OrbitSceneApi {
  const wrap = canvas.parentElement!;

  /* ——— Renderer ——— */
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020408);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 3000);
  camera.position.set(30, 12, 65);

  /* ——— Post-processing: Bloom ——— */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.6,   // strength
    0.4,   // radius
    0.85   // threshold
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  /* ——— Controls ——— */
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(30, 0, 0);
  controls.minDistance = 3;
  controls.maxDistance = 300;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;
  controls.maxPolarAngle = Math.PI * 0.88;
  controls.minPolarAngle = Math.PI * 0.08;

  let autoRotateTimer: ReturnType<typeof setTimeout>;
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
    clearTimeout(autoRotateTimer);
  });
  controls.addEventListener("end", () => {
    autoRotateTimer = setTimeout(() => { controls.autoRotate = true; }, 8000);
  });

  /* ——— Lighting ——— */
  scene.add(new THREE.AmbientLight(0x223344, 0.35));

  const sun = new THREE.DirectionalLight(0xfff5e0, 2.2);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x5588aa, 0.15);
  fill.position.set(-30, -10, -20);
  scene.add(fill);

  scene.add(createStars());

  const loader = new THREE.TextureLoader();

  /* ════════════════════════════════════════════
     Earth — day surface, night lights, clouds, atmosphere
     ════════════════════════════════════════════ */

  const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 64, 64);

  /* Day surface */
  const earthMat = new THREE.MeshStandardMaterial({
    color: 0x1a5f8a,
    metalness: 0.08,
    roughness: 0.72,
  });

  const base = import.meta.env.BASE_URL;
  function loadTex(path: string, cb: (tex: THREE.Texture) => void): void {
    loader.load(`${base}textures/${path}`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      cb(tex);
    }, undefined, () => {});
  }

  loadTex("earth-day.jpg", (tex) => {
    earthMat.map = tex;
    earthMat.color.set(0xffffff);
    earthMat.needsUpdate = true;
  });
  loadTex("earth-normal.jpg", (tex) => {
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    earthMat.normalMap = tex;
    earthMat.normalScale.set(0.8, 0.8);
    earthMat.needsUpdate = true;
  });
  loadTex("earth-specular.jpg", (tex) => {
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    earthMat.metalnessMap = tex;
    earthMat.needsUpdate = true;
  });
  loadTex("earth-bump.png", (tex) => {
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    earthMat.bumpMap = tex;
    earthMat.bumpScale = 0.03;
    earthMat.needsUpdate = true;
  });

  const earth = new THREE.Mesh(earthGeo, earthMat);
  scene.add(earth);

  /* Night lights (custom shader — only visible on dark side) */
  const nightMat = new THREE.ShaderMaterial({
    uniforms: {
      nightTexture: { value: null },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: EARTH_NIGHT_VERT,
    fragmentShader: EARTH_NIGHT_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  loader.load(`${base}textures/earth-night.jpg`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    nightMat.uniforms.nightTexture.value = tex;
  }, undefined, () => {});

  const nightEarth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS * 1.001, 64, 64),
    nightMat
  );
  scene.add(nightEarth);

  /* Clouds */
  const cloudsMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  loader.load(`${base}textures/earth-clouds.png`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    cloudsMat.alphaMap = tex;
    cloudsMat.needsUpdate = true;
  }, undefined, () => {});
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS * 1.008, 48, 48),
    cloudsMat
  );
  scene.add(clouds);

  /* Atmosphere glow (inner rim) */
  const makeAtm = (radius: number, color: number, intensity: number, power: number, side: THREE.Side): THREE.Mesh => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: ATM_VERT,
      fragmentShader: ATM_FRAG,
      uniforms: {
        glowColor: { value: new THREE.Color(color) },
        intensity: { value: intensity },
        power: { value: power },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      side,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 48, 48),
      mat
    );
    scene.add(mesh);
    return mesh;
  };

  makeAtm(EARTH_RADIUS * 1.04, 0x4ad4ff, 1.6, 4.5, THREE.FrontSide);
  makeAtm(EARTH_RADIUS * 1.12, 0x3399dd, 0.5, 2.5, THREE.BackSide);


  /* ════════════════════════════════════════════
     Moon
     ════════════════════════════════════════════ */

  const moonGeo = new THREE.SphereGeometry(MOON_RADIUS, 48, 48);
  const moonMat = new THREE.MeshStandardMaterial({
    color: 0xb0b0b0,
    metalness: 0.02,
    roughness: 0.98,
  });
  loader.load(`${base}textures/moon.jpg`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    moonMat.map = tex;
    moonMat.color.set(0xffffff);
    moonMat.needsUpdate = true;
  }, undefined, () => {});
  const moon = new THREE.Mesh(moonGeo, moonMat);
  moon.position.copy(MOON_POS);
  scene.add(moon);

  /* ════════════════════════════════════════════
     Trajectory tube with progress shader
     ════════════════════════════════════════════ */

  const TUBE_SEG = 800;
  const TUBE_RAD = 12;
  const tubeGeo = new THREE.TubeGeometry(curve, TUBE_SEG, 0.05, TUBE_RAD, true);

  const posCount = tubeGeo.attributes.position.count;
  const rings = TUBE_SEG + 1;
  const vertsPerRing = TUBE_RAD + 1;
  const uValues = new Float32Array(posCount);
  for (let i = 0; i < rings; i++) {
    const u = i / TUBE_SEG;
    for (let j = 0; j < vertsPerRing; j++) {
      const idx = i * vertsPerRing + j;
      if (idx < posCount) uValues[idx] = u;
    }
  }
  tubeGeo.setAttribute("uParam", new THREE.BufferAttribute(uValues, 1));

  const tubeUniforms = { progress: { value: 0 } };
  scene.add(new THREE.Mesh(tubeGeo, new THREE.ShaderMaterial({
    vertexShader: TUBE_VERT,
    fragmentShader: TUBE_FRAG,
    uniforms: tubeUniforms,
    transparent: true,
    depthWrite: false,
  })));

  /* ════════════════════════════════════════════
     Spacecraft + trail
     ════════════════════════════════════════════ */

  const { group: craft, engineGlow } = buildOrion();
  scene.add(craft);
  const craftForward = new THREE.Vector3(0, 0, 1);
  const trail = createTrailSystem(scene);

  const posMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xff6b4a, transparent: true, opacity: 0.45 })
  );
  scene.add(posMarker);

  /* ════════════════════════════════════════════
     Milestones — dots, sprites, labels, click-to-fly
     ════════════════════════════════════════════ */

  interface MilestoneMesh {
    dot: THREE.Mesh;
    ring: THREE.Mesh;
    pos: THREE.Vector3;
    data: Milestone;
  }
  interface Label {
    el: HTMLElement;
    key: string;
    worldPos: THREE.Vector3;
  }

  const milestoneMeshes: MilestoneMesh[] = [];
  const milestoneLabels: Label[] = [];
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  for (const ms of MILESTONES) {
    const u = metToU(ms.metHours);
    const pos = curve.getPointAt(u);

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 14, 14),
      new THREE.MeshBasicMaterial({ color: ms.color })
    );
    dot.position.copy(pos);
    scene.add(dot);

    const ringMat = new THREE.MeshBasicMaterial({
      color: ms.color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 32), ringMat);
    ring.position.copy(pos);
    scene.add(ring);

    milestoneMeshes.push({ dot, ring, pos: pos.clone(), data: ms });

    const el = document.createElement("div");
    el.className = "orbit-label";
    el.textContent = t(ms.key);
    el.style.color = `#${new THREE.Color(ms.color).getHexString()}`;
    wrap.appendChild(el);
    milestoneLabels.push({ el, key: ms.key, worldPos: pos.clone() });
  }

  /* Body labels */
  const bodyLabels: Label[] = [];
  for (const { key, worldPos, color } of [
    { key: "body.earth", worldPos: new THREE.Vector3(0, EARTH_RADIUS + 0.5, 0), color: "#4ad4ff" },
    { key: "body.moon", worldPos: MOON_POS.clone().add(new THREE.Vector3(0, MOON_RADIUS + 0.4, 0)), color: "#c8cdd0" },
  ]) {
    const el = document.createElement("div");
    el.className = "orbit-label orbit-label--body";
    el.textContent = t(key);
    el.style.color = color;
    wrap.appendChild(el);
    bodyLabels.push({ el, key, worldPos });
  }

  /* Tooltip */
  const tooltip = document.createElement("div");
  tooltip.className = "orbit-tooltip";
  tooltip.style.display = "none";
  wrap.appendChild(tooltip);

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(milestoneMeshes.map((m) => m.dot));

    if (hits.length > 0) {
      const ms = milestoneMeshes.find((m) => m.dot === hits[0].object);
      if (ms) {
        const sp = ms.pos.clone().project(camera);
        const x = (sp.x * 0.5 + 0.5) * rect.width;
        const y = (-sp.y * 0.5 + 0.5) * rect.height;
        const mh = ms.data.metHours;
        const d = Math.floor(mh / 24);
        const hr = Math.floor(mh % 24);
        const mn = Math.floor((mh * 60) % 60);
        tooltip.innerHTML =
          `<strong>${t(ms.data.key)}</strong>MET ${String(d).padStart(2, "0")}/${String(hr).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
        tooltip.style.display = "";
        canvas.style.cursor = "pointer";
      }
    } else {
      tooltip.style.display = "none";
      canvas.style.cursor = "grab";
    }
  });

  canvas.addEventListener("pointerleave", () => { tooltip.style.display = "none"; });

  /* Click milestone → fly camera to it */
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(milestoneMeshes.map((m) => m.dot));

    if (hits.length > 0) {
      const ms = milestoneMeshes.find((m) => m.dot === hits[0].object);
      if (ms) flyTo(ms.pos);
    }
  });

  function flyTo(target: THREE.Vector3): void {
    controls.autoRotate = false;
    clearTimeout(autoRotateTimer);

    const offset = new THREE.Vector3().subVectors(camera.position, controls.target).normalize().multiplyScalar(8);

    gsap.to(controls.target, {
      x: target.x, y: target.y, z: target.z,
      duration: 2.0, ease: "power3.inOut",
    });
    gsap.to(camera.position, {
      x: target.x + offset.x, y: target.y + offset.y + 2, z: target.z + offset.z,
      duration: 2.0, ease: "power3.inOut",
      onComplete: () => {
        autoRotateTimer = setTimeout(() => { controls.autoRotate = true; }, 8000);
      },
    });
  }

  /* Controls hint */
  const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const hint = document.createElement("div");
  hint.className = "orbit-controls-hint";
  hint.textContent = isTouchDevice
    ? "Drag to rotate · Pinch to zoom · Tap milestone to focus"
    : "Drag to rotate · Scroll to zoom · Click milestone to focus";
  wrap.appendChild(hint);
  setTimeout(() => { hint.style.opacity = "0"; }, 5000);
  setTimeout(() => hint.remove(), 6500);

  /* ════════════════════════════════════════════
     Animation loop
     ════════════════════════════════════════════ */

  let raf = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let frameCount = 0;

  function animate() {
    raf = requestAnimationFrame(animate);
    const rawProgress = clock.getProgress();
    const u = metToU(rawProgress * TOTAL_MET_HOURS);
    const now = performance.now();
    frameCount++;

    /* Spacecraft */
    const pos = curve.getPointAt(u);
    const tc = Math.min(0.999, Math.max(0.001, u));
    const tangent = curve.getTangentAt(tc);
    if (tangent.lengthSq() < 1e-10) tangent.set(1, 0, 0);
    else tangent.normalize();

    craft.position.copy(pos);
    craft.quaternion.setFromUnitVectors(craftForward, tangent);

    /* Engine glow pulse */
    (engineGlow.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.3 * Math.sin(now * 0.006);

    /* Position marker */
    posMarker.position.copy(pos);
    (posMarker.material as THREE.MeshBasicMaterial).opacity = 0.15 + 0.2 * Math.sin(now * 0.004);
    posMarker.scale.setScalar(1 + 0.35 * Math.sin(now * 0.003));

    /* Trail particles — emit every other frame */
    if (frameCount % 2 === 0) trail.push(pos);
    trail.tick();

    /* Tube progress */
    tubeUniforms.progress.value = u;

    /* Rotate bodies */
    const rot = 0.0012;
    earth.rotation.y += rot;
    nightEarth.rotation.y += rot;
    clouds.rotation.y += rot * 1.6;
    moon.rotation.y += 0.0003;

    /* Milestone rings face camera */
    for (const { ring } of milestoneMeshes) ring.lookAt(camera.position);

    /* Project all labels */
    const allLabels = [...milestoneLabels, ...bodyLabels];
    for (const { el, worldPos } of allLabels) {
      const projected = worldPos.clone().project(camera);
      if (projected.z > 1) { el.style.display = "none"; continue; }
      el.style.display = "";
      const x = (projected.x * 0.5 + 0.5) * canvasWidth;
      const y = (-projected.y * 0.5 + 0.5) * canvasHeight;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, calc(-100% - 10px))`;
    }

    controls.update();
    composer.render();
  }

  /* ════════════════════════════════════════════
     Resize / Fullscreen / Cleanup
     ════════════════════════════════════════════ */

  function resize() {
    const w = wrap.clientWidth || window.innerWidth;
    const h = wrap.clientHeight || 280;
    canvasWidth = w;
    canvasHeight = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloomPass.resolution.set(w, h);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      wrap.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  document.addEventListener("fullscreenchange", () => setTimeout(resize, 50));

  resize();
  animate();

  function updateLabels() {
    for (const lb of milestoneLabels) lb.el.textContent = t(lb.key);
    for (const lb of bodyLabels) lb.el.textContent = t(lb.key);
  }

  return {
    resize,
    toggleFullscreen,
    flyTo,
    updateLabels,
    dispose() {
      cancelAnimationFrame(raf);
      clearTimeout(autoRotateTimer);
      controls.dispose();
      renderer.dispose();
      trail.dispose();
      for (const { el } of milestoneLabels) el.remove();
      for (const { el } of bodyLabels) el.remove();
      tooltip.remove();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          if (Array.isArray(mesh.material)) mesh.material.forEach((m: THREE.Material) => m.dispose());
          else mesh.material.dispose();
        }
      });
    },
  };
}
