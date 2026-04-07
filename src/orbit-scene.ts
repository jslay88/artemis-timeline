import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import gsap from "gsap";
import { t } from "./i18n.ts";
import {
  getTrajectoryPoints,
  getPositionAtMET,
  getMoonPosition,
  OEM_START_MET_H,
  OEM_END_MET_H,
} from "./ephemeris.ts";

/* ════════════════════════════════════════════
   Configuration
   ════════════════════════════════════════════ */

/*
 * True-scale body sizes and distance.
 *   Earth radius  ≈ 6 371 km   → 1 unit
 *   Moon radius   ≈ 1 737 km   → 0.2727 units  (0.273× Earth)
 *   Earth–Moon    ≈ 404 740 km  → 63.53 units   (at mission epoch, Moon near apogee)
 */
const EARTH_RADIUS = 1;
const MOON_RADIUS = 0.2727;
// Moon position derived from real OEM ephemeris data (EME2000 → Three.js transform)
const MOON_POS: THREE.Vector3 = getMoonPosition();
const TOTAL_MET_HOURS = OEM_END_MET_H;
const SUN_DIR = new THREE.Vector3(1, 0.35, 0.5).normalize();

/*
 * Real trajectory from NASA/JSC OEM ephemeris data.
 * OEM covers MET +3.37h (post-TLI) through MET +217.3h (pre-splashdown).
 * Control points are time-uniform EME2000 positions converted to Three.js coords.
 */
const _trajPoints = getTrajectoryPoints(800);
const curve = new THREE.CatmullRomCurve3(_trajPoints, false, "catmullrom", 0.5);

/**
 * Map mission MET-hours to curve t parameter.
 * t=0 → OEM start (~MET 3.37h), t=1 → OEM end (~MET 217.3h).
 */
function metToU(metHours: number): number {
  return Math.min(1, Math.max(0, (metHours - OEM_START_MET_H) / (OEM_END_MET_H - OEM_START_MET_H)));
}

interface Milestone {
  key: string;
  metHours: number;
  color: number;
}

const MILESTONES: Milestone[] = [
  { key: "ms.launch", metHours: 0, color: 0x4ade80 },
  { key: "ms.tli", metHours: 25.244, color: 0x60a5fa },
  { key: "ms.lunarSoi", metHours: 102.111, color: 0xa78bfa },
  { key: "ms.closeApproach", metHours: 120.511, color: 0xfbbf24 },
  { key: "ms.maxDistance", metHours: 120.55, color: 0xf59e0b },
  { key: "ms.soiExit", metHours: 138.911, color: 0xa78bfa },
  { key: "ms.splashdown", metHours: 217.767, color: 0xef4444 },
];

export function sampleCraftPosition(u: number): THREE.Vector3 {
  return curve.getPoint(Math.min(1, Math.max(0, u)));
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
  float traveled = 1.0 - smoothstep(progress - 0.004, progress + 0.004, vU);

  // Traveled = NASA orange #FC3D21 linearized (sRGB->linear)
  vec3 traveledColor = vec3(0.961, 0.047, 0.014);
  vec3 futureColor   = vec3(0.25, 0.25, 0.25);
  vec3 color = mix(futureColor, traveledColor, traveled);

  // Bright leading edge at spacecraft position
  float lead = smoothstep(progress - 0.015, progress, vU)
             * (1.0 - smoothstep(progress, progress + 0.006, vU));
  color = mix(color, vec3(1.0, 0.35, 0.18), lead * 2.0);

  float alpha = mix(0.16, 0.82, traveled);
  gl_FragColor = vec4(color, alpha);
}`;

/* ════════════════════════════════════════════
   Orion Spacecraft
   ════════════════════════════════════════════ */

interface OrionCraft {
  group: THREE.Group;
  engineGlow: THREE.Mesh;
}

function buildOrionPlaceholder(): OrionCraft {
  const group = new THREE.Group();
  const engineGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xFC3D21, transparent: true, opacity: 0.25 })
  );
  engineGlow.position.z = 0.73;
  group.add(engineGlow);
  group.scale.setScalar(0.25);
  return { group, engineGlow };
}

function loadOrionModel(group: THREE.Group, basePath: string, mgr?: THREE.LoadingManager): void {
  new GLTFLoader(mgr).load(
    `${basePath}models/orion.glb`,
    (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const targetSize = 0.8;
      const scale = targetSize / maxDim;
      model.scale.setScalar(scale);

      const center = box.getCenter(new THREE.Vector3());
      model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
      model.rotation.x = -Math.PI / 2;

      group.add(model);
    },
    undefined,
    (err) => { console.warn("Orion GLB load failed, using placeholder:", err); },
  );
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
      color: { value: new THREE.Color(0xbb4422) },
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
        gl_PointSize = min(size * pixelRatio * (200.0 / -mvPos.z), 20.0);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float a = smoothstep(0.5, 0.2, d) * vAlpha;
        gl_FragColor = vec4(color, a);
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
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
    alphas[head] = 0.55;
    sizes[head] = 1.2;
    head = (head + 1) % COUNT;
  }

  function tick(): void {
    for (let i = 0; i < COUNT; i++) {
      alphas[i] *= 0.88;
      sizes[i] *= 0.92;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
  }

  return { push, tick, dispose: () => { geo.dispose(); mat.dispose(); } };
}

/* ════════════════════════════════════════════
   Skybox — NASA Deep Star Maps 2020
   ════════════════════════════════════════════
   Equirectangular panorama of 1.7 billion real stars (Gaia DR2 +
   Hipparcos-2 + Tycho-2) mapped onto a large inverted sphere.
   Source: https://svs.gsfc.nasa.gov/4851 (public domain).
   ════════════════════════════════════════════ */

function createStarSkybox(base: string, renderer: THREE.WebGLRenderer, mgr?: THREE.LoadingManager): THREE.Mesh {
  const SKYBOX_RADIUS = 1400;
  const geo = new THREE.SphereGeometry(SKYBOX_RADIUS, 64, 32);
  const mat = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });

  new THREE.TextureLoader(mgr).load(
    `${base}textures/starmap.jpg`,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      mat.map = tex;
      mat.needsUpdate = true;
    },
    undefined,
    () => {},
  );

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  return mesh;
}

/* ════════════════════════════════════════════
   Main Scene
   ════════════════════════════════════════════ */

export interface OrbitClock {
  getProgress: () => number;
}

export interface OrbitLoadCallbacks {
  onProgress?: (loaded: number, total: number) => void;
  onReady?: () => void;
}

export interface OrbitSceneApi {
  resize: () => void;
  toggleFullscreen: () => void;
  flyTo: (target: THREE.Vector3) => void;
  flyToMET: (metHours: number) => void;
  focusCraft: () => void;
  updateLabels: () => void;
  dispose: () => void;
}

export function createOrbitScene(
  canvas: HTMLCanvasElement,
  clock: OrbitClock,
  loadCallbacks?: OrbitLoadCallbacks,
): OrbitSceneApi {
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

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 3000);
  // Frame the trajectory: Earth (0,0,0) → Moon area (~-20, -29, 53)
  camera.position.set(20, 35, 90);

  /* ——— Post-processing: Bloom ——— */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.45,  // strength
    0.35,  // radius
    0.92   // threshold
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  /* ——— Controls ——— */
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(-10, -14, 26);
  controls.minDistance = 0.05;
  controls.maxDistance = 300;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;
  controls.maxPolarAngle = Math.PI * 0.88;
  controls.minPolarAngle = Math.PI * 0.08;

  let autoRotateTimer: ReturnType<typeof setTimeout>;
  let autoRotateEnabled = true; // user-controlled master toggle

  function setAutoRotate(enabled: boolean): void {
    autoRotateEnabled = enabled;
    controls.autoRotate = enabled;
    const btn = document.getElementById("orbit-autorotate");
    if (btn) btn.dataset.active = String(enabled);
  }

  controls.addEventListener("start", () => {
    gsap.killTweensOf(camera.position);
    gsap.killTweensOf(controls.target);
    controls.autoRotate = false;
    clearTimeout(autoRotateTimer);
  });
  controls.addEventListener("end", () => {
    if (!autoRotateEnabled) return;
    autoRotateTimer = setTimeout(() => { controls.autoRotate = true; }, 8000);
  });

  document.getElementById("orbit-autorotate")?.addEventListener("click", () => {
    setAutoRotate(!autoRotateEnabled);
  });

  /* ——— Follow state — which object the camera orbits ——— */
  type FollowTarget = 'craft' | 'earth' | 'moon' | 'milestone';
  let followTarget: FollowTarget = 'craft';
  let followingActive = false; // activated after initial fly-in animation

  /* ——— Lighting ——— */
  scene.add(new THREE.AmbientLight(0x223344, 0.35));

  const sun = new THREE.DirectionalLight(0xfff5e0, 2.2);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x5588aa, 0.15);
  fill.position.set(-30, -10, -20);
  scene.add(fill);

  const base = import.meta.env.BASE_URL;

  /* ——— Asset loading — managed loader for initial load, unmanaged for LOD ——— */
  const loadMgr = new THREE.LoadingManager(
    () => loadCallbacks?.onReady?.(),
    (_url, loaded, total) => loadCallbacks?.onProgress?.(loaded, total),
  );
  const loader = new THREE.TextureLoader(loadMgr);
  const lodLoader = new THREE.TextureLoader();

  scene.add(createStarSkybox(base, renderer, loadMgr));

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
  function loadTex(path: string, cb: (tex: THREE.Texture) => void, lod = false): void {
    (lod ? lodLoader : loader).load(`${base}textures/${path}`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      cb(tex);
    }, undefined, () => {});
  }

  let earthHdLoaded = false;
  let earthHdLoading = false;
  const EARTH_LOD_DIST = 12;

  loadTex("earth-day.jpg", (tex) => {
    earthMat.map = tex;
    earthMat.color.set(0xffffff);
    earthMat.needsUpdate = true;
  });

  function checkEarthLOD(): void {
    if (earthHdLoaded || earthHdLoading) return;
    const dist = camera.position.length();
    if (dist < EARTH_LOD_DIST) {
      earthHdLoading = true;
      loadTex("earth-day-hd.jpg", (tex) => {
        earthMat.map = tex;
        earthMat.needsUpdate = true;
        earthHdLoaded = true;
      }, true);
    }
  }
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

  /* Clouds — LOD texture swap (2K default, 4K when close) */
  const cloudsMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  let cloudsHdLoaded = false;
  let cloudsHdLoading = false;
  const CLOUD_LOD_DIST = 8;

  function applyCloudTex(tex: THREE.Texture): void {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    cloudsMat.alphaMap = tex;
    cloudsMat.needsUpdate = true;
  }

  loader.load(`${base}textures/earth-clouds.jpg`, applyCloudTex, undefined, () => {});

  function checkCloudLOD(): void {
    if (cloudsHdLoaded || cloudsHdLoading) return;
    const dist = camera.position.length();
    if (dist < CLOUD_LOD_DIST) {
      cloudsHdLoading = true;
      lodLoader.load(`${base}textures/earth-clouds-hd.jpg`, (tex) => {
        applyCloudTex(tex);
        cloudsHdLoaded = true;
      }, undefined, () => { cloudsHdLoading = false; });
    }
  }

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

  makeAtm(EARTH_RADIUS * 1.04, 0x88ccff, 1.4, 5.0, THREE.FrontSide);
  makeAtm(EARTH_RADIUS * 1.12, 0x4488bb, 0.4, 2.5, THREE.BackSide);


  /* ════════════════════════════════════════════
     Moon
     ════════════════════════════════════════════ */

  const moonGeo = new THREE.SphereGeometry(MOON_RADIUS, 48, 48);
  const moonMat = new THREE.MeshStandardMaterial({
    color: 0xb0b0b0,
    metalness: 0.02,
    roughness: 0.98,
  });
  let moonHdLoaded = false;
  let moonHdLoading = false;
  const MOON_LOD_DIST = 20;

  loader.load(`${base}textures/moon.jpg`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    moonMat.map = tex;
    moonMat.color.set(0xffffff);
    moonMat.needsUpdate = true;
  }, undefined, () => {});

  function checkMoonLOD(): void {
    if (moonHdLoaded || moonHdLoading) return;
    const dist = camera.position.distanceTo(MOON_POS);
    if (dist < MOON_LOD_DIST) {
      moonHdLoading = true;
      lodLoader.load(`${base}textures/moon-hd.jpg`, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        moonMat.map = tex;
        moonMat.needsUpdate = true;
        moonHdLoaded = true;
      }, undefined, () => { moonHdLoading = false; });
    }
  }

  const moon = new THREE.Mesh(moonGeo, moonMat);
  moon.position.copy(MOON_POS);
  scene.add(moon);

  /* ════════════════════════════════════════════
     Trajectory tube with progress shader
     ════════════════════════════════════════════ */

  const TUBE_SEG = 800;
  const TUBE_RAD = 12;
  const tubeGeo = new THREE.TubeGeometry(curve, TUBE_SEG, 0.0125, TUBE_RAD, false);

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
  const tubeMesh = new THREE.Mesh(tubeGeo, new THREE.ShaderMaterial({
    vertexShader: TUBE_VERT,
    fragmentShader: TUBE_FRAG,
    uniforms: tubeUniforms,
    transparent: true,
    depthWrite: false,
  }));
  tubeMesh.renderOrder = 10;
  scene.add(tubeMesh);

  // TubeGeometry uses arc-length parameterization (getPointAt) but the
  // spacecraft position uses raw parameter (getPoint). Build a lookup
  // to convert raw t → arc-length fraction for the shader.
  const ARC_LUT_N = 2000;
  const arcLengths = curve.getLengths(ARC_LUT_N);
  const totalArcLen = arcLengths[ARC_LUT_N];
  function rawToArcFraction(rawU: number): number {
    const idx = rawU * ARC_LUT_N;
    const i = Math.min(Math.floor(idx), ARC_LUT_N - 1);
    const frac = idx - i;
    const len = arcLengths[i] + frac * (arcLengths[i + 1] - arcLengths[i]);
    return len / totalArcLen;
  }

  /* ════════════════════════════════════════════
     Spacecraft + trail
     ════════════════════════════════════════════ */

  const { group: craft, engineGlow } = buildOrionPlaceholder();
  engineGlow.visible = false;
  scene.add(craft);
  loadOrionModel(craft, base, loadMgr);
  const craftForward = new THREE.Vector3(0, 0, -1);
  const trail = createTrailSystem(scene);

  /* Depth mask — invisible sphere that punches a gap in the tube at spacecraft position */
  const posMask = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 16),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.FrontSide })
  );
  posMask.renderOrder = 5;
  scene.add(posMask);


  /* ════════════════════════════════════════════
     Milestones — dots, sprites, labels, click-to-fly
     ════════════════════════════════════════════ */

  interface MilestoneMesh {
    dot: THREE.Mesh;
    ring: THREE.Mesh;
    line: THREE.Line;
    pos: THREE.Vector3;
    tipPos: THREE.Vector3;
    data: Milestone;
    svgLine: SVGLineElement;
    svgDot: SVGCircleElement;
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

  const CLUSTER_PX   = 44;   // screen-dist threshold to group dots into one stack
  const LABEL_H      = 26;   // approx label height px
  const LABEL_GAP    = 4;    // gap between stacked labels px
  const RING_RADIUS  = 0.52; // world-space radius of outer ring geometry + margin
  const MIN_CLEAR_PX = 8;    // minimum px clearance above ring screen edge

  /* SVG overlay for leader lines */
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;";
  wrap.appendChild(svg);

  for (const ms of MILESTONES) {
    let pos: THREE.Vector3;

    if (ms.key === "ms.launch" || ms.key === "ms.splashdown") {
      const rawPos = getPositionAtMET(ms.metHours);
      pos = rawPos.clone().normalize().multiplyScalar(EARTH_RADIUS * 1.02);
    } else {
      pos = getPositionAtMET(ms.metHours);
    }

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 14, 14),
      new THREE.MeshBasicMaterial({ color: ms.color })
    );
    dot.position.copy(pos);
    dot.renderOrder = 10;
    scene.add(dot);

    const ringMat = new THREE.MeshBasicMaterial({
      color: ms.color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 32), ringMat);
    ring.position.copy(pos);
    ring.renderOrder = 10;
    scene.add(ring);

    /* SVG line + tip dot for this milestone */
    const hex = `#${new THREE.Color(ms.color).getHexString()}`;
    const svgLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    svgLine.setAttribute("stroke", hex);
    svgLine.setAttribute("stroke-width", "1");
    svgLine.setAttribute("stroke-opacity", "0.6");
    svg.appendChild(svgLine);
    // Small filled circle at line tip
    const svgDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    svgDot.setAttribute("r", "2");
    svgDot.setAttribute("fill", hex);
    svgDot.setAttribute("fill-opacity", "0.8");
    svg.appendChild(svgDot);

    // Dummy line object to satisfy interface (no 3D line needed)
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    const tipPos = pos.clone();
    milestoneMeshes.push({ dot, ring, line, pos: pos.clone(), tipPos, data: ms, svgLine, svgDot });

    const el = document.createElement("div");
    el.className = "orbit-label orbit-label--clickable";
    el.textContent = t(ms.key);
    el.style.color = hex;
    el.addEventListener("click", () => focusOn('milestone', milestoneMeshes.find(m => m.data.key === ms.key)!.pos, 3));
    wrap.appendChild(el);
    milestoneLabels.push({ el, key: ms.key, worldPos: tipPos });
  }

  /* Body labels */
  const bodyLabels: Label[] = [];
  for (const { key, worldPos, color } of [
    { key: "body.earth", worldPos: new THREE.Vector3(0, EARTH_RADIUS + 0.5, 0), color: "#88ccff" },
    { key: "body.moon", worldPos: MOON_POS.clone().add(new THREE.Vector3(0, MOON_RADIUS + 0.4, 0)), color: "#c8cdd0" },
  ]) {
    const el = document.createElement("div");
    el.className = "orbit-label orbit-label--body";
    el.textContent = t(key);
    el.style.color = color;
    wrap.appendChild(el);
    bodyLabels.push({ el, key, worldPos });
  }

  /* Craft label — "ARTEMIS II" badge above spacecraft */
  const craftLabelEl = document.createElement("div");
  craftLabelEl.className = "orbit-label orbit-label--craft";
  craftLabelEl.textContent = "ARTEMIS II";
  craftLabelEl.addEventListener("click", () => focusOn('craft', posMask.position.clone(), 0.8));
  wrap.appendChild(craftLabelEl);

  /* SVG connector for craft label */
  const craftSvgLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  craftSvgLine.setAttribute("stroke", "#FC3D21");
  craftSvgLine.setAttribute("stroke-width", "1");
  craftSvgLine.setAttribute("stroke-opacity", "0.55");
  svg.appendChild(craftSvgLine);
  const craftSvgDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  craftSvgDot.setAttribute("r", "2.5");
  craftSvgDot.setAttribute("fill", "#FC3D21");
  craftSvgDot.setAttribute("fill-opacity", "0.9");
  svg.appendChild(craftSvgDot);

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
    // Only hover-detect spacecraft/Earth/Moon — not milestone dots
    const bodyHits = raycaster.intersectObjects([posMask, earth, moon]);
    canvas.style.cursor = bodyHits.length > 0 ? "pointer" : "grab";
  });

  canvas.addEventListener("pointerleave", () => { tooltip.style.display = "none"; });

  /* Click on Earth, Moon or spacecraft → fly camera to orbit it */
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    // Only spacecraft marker, Earth, Moon — milestones via label click
    const bodyHits = raycaster.intersectObjects([posMask, earth, moon]);
    if (bodyHits.length > 0) {
      const obj = bodyHits[0].object;
      if (obj === posMask) {
        focusOn('craft', posMask.position.clone(), 0.8);
      } else if (obj === earth) {
        focusOn('earth', new THREE.Vector3(0, 0, 0), 4);
      } else if (obj === moon) {
        focusOn('moon', MOON_POS.clone(), 1.0);
      }
    }
  });

  function focusOn(type: FollowTarget, worldPos: THREE.Vector3, orbitDist: number): void {
    followTarget = type;
    followingActive = false;
    controls.autoRotate = false;
    clearTimeout(autoRotateTimer);

    const offset = new THREE.Vector3()
      .subVectors(camera.position, controls.target)
      .normalize()
      .multiplyScalar(orbitDist);
    if (offset.lengthSq() < 0.01) offset.set(0, 0.4, 1).normalize().multiplyScalar(orbitDist);

    gsap.killTweensOf(controls.target);
    gsap.killTweensOf(camera.position);

    gsap.to(controls.target, {
      x: worldPos.x, y: worldPos.y, z: worldPos.z,
      duration: 2.0, ease: "power3.inOut",
    });
    gsap.to(camera.position, {
      x: worldPos.x + offset.x,
      y: worldPos.y + offset.y + (type === 'milestone' ? 2 : 0),
      z: worldPos.z + offset.z,
      duration: 2.0, ease: "power3.inOut",
      onComplete: () => {
        followingActive = true;
        if (autoRotateEnabled) controls.autoRotate = true;
      },
    });
  }

  /* Keep flyTo for external API backwards-compat */
  function flyTo(target: THREE.Vector3): void {
    focusOn('milestone', target, 3);
  }

  function flyToMET(metHours: number): void {
    // Find closest milestone to given MET
    const ms = MILESTONES.reduce((a, b) =>
      Math.abs(a.metHours - metHours) < Math.abs(b.metHours - metHours) ? a : b
    );
    const mesh = milestoneMeshes.find((m) => m.data.key === ms.key);
    if (mesh) focusOn('milestone', mesh.pos, 3);
  }

  function focusCraft(): void {
    const rawProgress = clock.getProgress();
    const metHoursNow = rawProgress * TOTAL_MET_HOURS;
    const uNow = metToU(metHoursNow);
    const craftPos = curve.getPoint(Math.max(0, Math.min(1, uNow)));
    focusOn('craft', craftPos, 0.8);
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

  /* Reset button — fly back to overview */
  document.getElementById("orbit-reset")?.addEventListener("click", () => {
    followingActive = false;
    followTarget = 'craft';
    gsap.killTweensOf(controls.target);
    gsap.killTweensOf(camera.position);
    gsap.to(camera.position, { x: 20, y: 35, z: 90, duration: 2.0, ease: "power3.inOut" });
    gsap.to(controls.target, {
      x: -10, y: -14, z: 26, duration: 2.0, ease: "power3.inOut",
      onComplete: () => { if (autoRotateEnabled) controls.autoRotate = true; },
    });
  });

  /* ── Label / marker visibility toggles ───────────────────────────────── */
  let labelsVisible  = true;
  let markersVisible = true;

  function setLabelsVisible(on: boolean) {
    labelsVisible = on;
    const btn = document.getElementById("orbit-toggle-labels");
    if (btn) btn.dataset.active = String(on);
    // Hide/show all orbit labels and the SVG overlay
    wrap.querySelectorAll<HTMLElement>(".orbit-label").forEach(el => {
      el.style.display = on ? "" : "none";
    });
    svg.style.display = on ? "" : "none";
  }

  function setMarkersVisible(on: boolean) {
    markersVisible = on;
    const btn = document.getElementById("orbit-toggle-markers");
    if (btn) btn.dataset.active = String(on);
    for (const mm of milestoneMeshes) {
      mm.dot.visible  = on;
      mm.ring.visible = on;
    }
  }

  document.getElementById("orbit-toggle-labels")?.addEventListener("click", () => setLabelsVisible(!labelsVisible));
  document.getElementById("orbit-toggle-markers")?.addEventListener("click", () => setMarkersVisible(!markersVisible));

  /* ── Visitor counter (counterapi.dev — free, no registration, static-hosting safe) */
  {
    const countEl  = document.getElementById("visitor-count");
    const wrapEl   = document.getElementById("visitor-counter");
    if (countEl && wrapEl) {
      fetch("https://api.counterapi.dev/v1/artemis-ii-timeline/visits/up")
        .then(r => r.json())
        .then((d: { count: number }) => {
          countEl.textContent = d.count.toLocaleString();
        })
        .catch(() => {
          wrapEl.style.display = "none";
        });
    }
  }

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
    const metHours = rawProgress * TOTAL_MET_HOURS;
    const u = metToU(metHours);
    frameCount++;

    /* Spacecraft — position from curve so it stays exactly on the tube */
    const pos = curve.getPoint(Math.max(0, Math.min(1, u)));
    // Tangent from curve (stays aligned with the tube geometry)
    const tc = Math.max(0.001, Math.min(0.999, u));
    const tangent = curve.getTangent(tc);
    if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1);
    else tangent.normalize();

    craft.position.copy(pos);
    craft.quaternion.setFromUnitVectors(craftForward, tangent);

    /* Depth mask + craft point light */
    posMask.position.copy(pos);

    /* Trail particles — emit every other frame */
    if (frameCount % 2 === 0) trail.push(pos);
    trail.tick();

    /* Tube progress — convert raw parameter to arc-length fraction */
    tubeUniforms.progress.value = rawToArcFraction(u);

    /* LOD — swap in HD textures when camera is close */
    checkCloudLOD();
    checkEarthLOD();
    checkMoonLOD();

    /* Rotate bodies */
    const rot = 0.0012;
    earth.rotation.y += rot;
    nightEarth.rotation.y += rot;
    clouds.rotation.y += rot * 1.6;
    moon.rotation.y += 0.0003;

    /* Follow active target — keep OrbitControls centred on it */
    if (followingActive) {
      if (followTarget === 'craft') {
        controls.target.copy(pos);
      }
      // earth / moon / milestone: controls.target was set by GSAP and stays put
    }

    /* Distance-based milestone marker scaling — shrink when camera is close */
    for (const { dot, ring, pos: mpos } of milestoneMeshes) {
      const dist = camera.position.distanceTo(mpos);
      const scale = THREE.MathUtils.clamp(dist / 5, 0.02, 0.2);
      dot.scale.setScalar(scale);
      ring.scale.setScalar(scale);
    }

    /* Milestone rings face camera */
    for (const { ring } of milestoneMeshes) ring.lookAt(camera.position);

    /* Leader lines + labels — screen-space with dynamic stacking.
       Step 1: project all dots to screen coords.
       Step 2: group milestones that are within STACK_GAP*2 px of each other.
       Step 3: assign stacked offsets so labels never overlap. */

    // ── Step 1: project all dots to screen space ──────────────────────────────
    const screenPositions = new Map<string, { sx: number; sy: number; visible: boolean }>();
    for (const mm of milestoneMeshes) {
      const projected = mm.pos.clone().project(camera);
      const visible = projected.z <= 1;
      const sx = (projected.x * 0.5 + 0.5) * canvasWidth;
      const sy = (-projected.y * 0.5 + 0.5) * canvasHeight;
      screenPositions.set(mm.data.key, { sx, sy, visible });
    }

    // ── Step 2: cluster nearby dots, assign each label a final screen Y ───────
    // labelY[key] = final screen Y of the label's bottom edge (line tip).
    // For clustered dots: one shared anchor X, labels stacked bottom-up.
    const labelPos = new Map<string, { lx: number; ly: number }>();
    const processed = new Set<string>();

    for (const mm of milestoneMeshes) {
      if (processed.has(mm.data.key)) continue;
      const sp = screenPositions.get(mm.data.key)!;

      // Gather all milestones within CLUSTER_PX of this dot
      const cluster = milestoneMeshes.filter(m => {
        const o = screenPositions.get(m.data.key)!;
        return Math.hypot(sp.sx - o.sx, sp.sy - o.sy) < CLUSTER_PX;
      });
      cluster.sort((a, b) => a.data.metHours - b.data.metHours);

      // Cluster anchor = average dot screen position
      const ax = cluster.reduce((s, m) => s + screenPositions.get(m.data.key)!.sx, 0) / cluster.length;
      const ay = cluster.reduce((s, m) => s + screenPositions.get(m.data.key)!.sy, 0) / cluster.length;

      // Compute the screen-space radius of the outer ring for the representative dot.
      // Project a point RING_RADIUS world-units above the dot in camera-up direction
      // → pixel distance = clearance needed so labels never touch the ring.
      const ringEdgeWorld = mm.pos.clone().add(camera.up.clone().multiplyScalar(RING_RADIUS));
      const ringEdgeProj = ringEdgeWorld.project(camera);
      const ringEdgeSy = (-ringEdgeProj.y * 0.5 + 0.5) * canvasHeight;
      const clearance = Math.min(Math.abs(ay - ringEdgeSy) + MIN_CLEAR_PX, canvasHeight * 0.32);

      // Stack labels upward: bottom of label[0] starts at clearance above dot
      cluster.forEach((m, i) => {
        const ly = ay - clearance - i * (LABEL_H + LABEL_GAP);
        labelPos.set(m.data.key, { lx: ax, ly });
      });
      cluster.forEach(m => processed.add(m.data.key));
    }

    // ── Step 3: occluder check + apply SVG lines and CSS labels ───────────────
    const occluders = [earth, moon, craft];

    for (const mm of milestoneMeshes) {
      const sp = screenPositions.get(mm.data.key)!;

      const toDot = mm.pos.clone().sub(camera.position);
      const distToDot = toDot.length();
      const occlusionRay = new THREE.Raycaster(camera.position, toDot.normalize(), 0, distToDot - 0.1);
      const occluded = occlusionRay.intersectObjects(occluders, true).length > 0;

      if (!sp.visible || occluded) {
        mm.svgLine.setAttribute("display", "none");
        mm.svgDot.setAttribute("display", "none");
        const lb = milestoneLabels.find(l => l.key === mm.data.key);
        if (lb) lb.el.style.display = "none";
        continue;
      }

      const { lx, ly } = labelPos.get(mm.data.key) ?? { lx: sp.sx, ly: sp.sy - MIN_CLEAR_PX - LABEL_H };

      // SVG line: from dot up to label tip
      mm.svgLine.setAttribute("display", "");
      mm.svgLine.setAttribute("x1", String(sp.sx));
      mm.svgLine.setAttribute("y1", String(sp.sy));
      mm.svgLine.setAttribute("x2", String(lx));
      mm.svgLine.setAttribute("y2", String(ly));

      mm.svgDot.setAttribute("display", "");
      mm.svgDot.setAttribute("cx", String(lx));
      mm.svgDot.setAttribute("cy", String(ly));

      const lb = milestoneLabels.find(l => l.key === mm.data.key);
      if (lb) {
        lb.el.style.display = labelsVisible ? "" : "none";
        lb.el.style.transform = `translate(${lx}px, ${ly}px) translate(-50%, calc(-100% - 3px))`;
      }
    }

    /* Body labels */
    for (const { el, worldPos } of bodyLabels) {
      const projected = worldPos.clone().project(camera);
      if (projected.z > 1 || !labelsVisible) { el.style.display = "none"; continue; }
      el.style.display = "";
      const x = (projected.x * 0.5 + 0.5) * canvasWidth;
      const y = (-projected.y * 0.5 + 0.5) * canvasHeight;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, calc(-100% - 10px))`;
    }

    /* Craft label — connector line from label down to spacecraft dot */
    {
      // Dot: project the craft position itself
      const dotProj = pos.clone().project(camera);
      if (dotProj.z > 1) {
        craftLabelEl.style.display = "none";
        craftSvgLine.setAttribute("display", "none");
        craftSvgDot.setAttribute("display", "none");
      } else {
        const dotX = (dotProj.x * 0.5 + 0.5) * canvasWidth;
        const dotY = (-dotProj.y * 0.5 + 0.5) * canvasHeight;

        // Label anchor: fixed 60px above the dot in screen space, clamped so it
        // never wanders more than 120px from the dot when far away.
        const camDist = camera.position.distanceTo(pos);
        const worldOffset = Math.min(Math.max(camDist * 0.10, 0.15), 0.9);
        const anchorWorld = pos.clone().add(camera.up.clone().multiplyScalar(worldOffset));
        const anchorProj = anchorWorld.project(camera);
        const labelX = (anchorProj.x * 0.5 + 0.5) * canvasWidth;
        const labelY = (-anchorProj.y * 0.5 + 0.5) * canvasHeight;

        craftLabelEl.style.display = labelsVisible ? "" : "none";
        craftLabelEl.style.transform = `translate(${labelX}px, ${labelY}px) translate(-50%, calc(-100% - 4px))`;

        // SVG line from label-bottom to dot
        craftSvgLine.setAttribute("display", labelsVisible ? "" : "none");
        craftSvgLine.setAttribute("x1", String(labelX));
        craftSvgLine.setAttribute("y1", String(labelY));
        craftSvgLine.setAttribute("x2", String(dotX));
        craftSvgLine.setAttribute("y2", String(dotY));

        craftSvgDot.setAttribute("display", "");
        craftSvgDot.setAttribute("cx", String(dotX));
        craftSvgDot.setAttribute("cy", String(dotY));
      }
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

  /* Default: orbit spacecraft — fly in once loading is complete */
  const _doInitialFocus = (): void => {
    const rawProgress = clock.getProgress();
    const metHoursNow = rawProgress * TOTAL_MET_HOURS;
    const uNow = metToU(metHoursNow);
    const initCraftPos = curve.getPoint(Math.max(0, Math.min(1, uNow)));
    focusOn('craft', initCraftPos, 10);
  };
  if (loadCallbacks) {
    // Wrap the onReady callback so we can delay slightly for the loading screen fade
    const _wrappedReady = loadCallbacks.onReady;
    loadCallbacks.onReady = () => {
      _wrappedReady?.();
      setTimeout(_doInitialFocus, 800);
    };
  } else {
    setTimeout(_doInitialFocus, 1500);
  }

  function updateLabels() {
    for (const lb of milestoneLabels) lb.el.textContent = t(lb.key);
    for (const lb of bodyLabels) lb.el.textContent = t(lb.key);
  }

  return {
    resize,
    toggleFullscreen,
    flyTo,
    flyToMET,
    focusCraft,
    updateLabels,
    dispose() {
      cancelAnimationFrame(raf);
      clearTimeout(autoRotateTimer);
      controls.dispose();
      renderer.dispose();
      trail.dispose();
      for (const { el } of milestoneLabels) el.remove();
      for (const { el } of bodyLabels) el.remove();
      craftLabelEl.remove();
      craftSvgLine.remove();
      craftSvgDot.remove();
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
