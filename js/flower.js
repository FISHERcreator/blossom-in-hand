/**
 * flower.js
 * ------------------------------------------------------------
 * A ~20k-particle flower with two authored shapes:
 *   position attribute -> tight, layered bud
 *   aBloom attribute   -> fully opened camellia
 *
 * Everything morphs on the GPU. The CPU only advances `uOpen`, time and
 * the fingertip influence, so the petals stay at 60fps while MediaPipe
 * is doing inference in the background.
 *
 * Palette is authorial: deep wine buds that unfold into blush, coral and
 * warm gold, rendered additively so layers glow through one another.
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;

/* ---------------------------------------------------------------- */
/* Deterministic RNG so the flower is identical on every reload.     */
/* ---------------------------------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x5e0f10a7);
const range = (min, max) => min + rand() * (max - min);
const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];

function smoothstep(min, max, value) {
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return t * t * (3 - 2 * t);
}

function mixColor(a, b, t) {
  return a.clone().lerp(b, t);
}

/* ---------------------------------------------------------------- */
/* Palettes                                                          */
/* ---------------------------------------------------------------- */

const C = {
  budDeep: new THREE.Color('#4d0a2a'),
  budWine: new THREE.Color('#7c123d'),
  budRose: new THREE.Color('#a92b55'),
  budTip: new THREE.Color('#d98a8f'),

  bloomDeep: new THREE.Color('#e0447e'),
  bloomPink: new THREE.Color('#ff7fac'),
  bloomBlush: new THREE.Color('#ffb9cc'),
  bloomCream: new THREE.Color('#ffe9d2'),
  bloomCoral: new THREE.Color('#ff9a87'),

  goldDeep: new THREE.Color('#c07a2d'),
  gold: new THREE.Color('#ffc76f'),
  goldPale: new THREE.Color('#ffe9b0'),
};

const LAYERS = [
  {
    name: 'outer',
    petals: 8,
    perPetal: 880,
    length: 2.06,
    width: 0.44,
    baseRadius: 0.16,
    cup: 0.34,
    curl: 0.28,
    z: -0.2,
    tilt: 0.1,
    budRadius: 0.48,
    budHeight: 1.8,
    budY: -0.8,
    wrap: 0.94,
    size: 1.15,
    delay: [0.0, 0.12],
    edge: [C.bloomPink, C.bloomCream, C.bloomBlush],
  },
  {
    name: 'middle',
    petals: 8,
    perPetal: 740,
    length: 1.52,
    width: 0.35,
    baseRadius: 0.14,
    cup: 0.46,
    curl: 0.34,
    z: -0.02,
    tilt: 0.16,
    budRadius: 0.41,
    budHeight: 1.68,
    budY: -0.75,
    wrap: 0.96,
    size: 1.0,
    delay: [0.06, 0.2],
    edge: [C.bloomDeep, C.bloomCream, C.bloomPink],
  },
  {
    name: 'inner',
    petals: 7,
    perPetal: 500,
    length: 1.03,
    width: 0.27,
    baseRadius: 0.12,
    cup: 0.52,
    curl: 0.4,
    z: 0.15,
    tilt: 0.22,
    budRadius: 0.35,
    budHeight: 1.52,
    budY: -0.66,
    wrap: 0.98,
    size: 0.86,
    delay: [0.14, 0.28],
    edge: [C.bloomCoral, C.goldPale, C.bloomDeep],
  },
  {
    name: 'heart',
    petals: 5,
    perPetal: 230,
    length: 0.56,
    width: 0.18,
    baseRadius: 0.08,
    cup: 0.3,
    curl: 0.24,
    z: 0.28,
    tilt: 0.3,
    budRadius: 0.28,
    budHeight: 1.32,
    budY: -0.56,
    wrap: 1.0,
    size: 0.78,
    delay: [0.2, 0.36],
    edge: [C.gold, C.goldPale, C.bloomCoral],
  },
];

/* ---------------------------------------------------------------- */
/* Shaders                                                           */
/* ---------------------------------------------------------------- */

const FLOWER_VERT = /* glsl */ `
  attribute vec3 aBloom;
  attribute vec3 aColorBloom;
  attribute vec3 aColorBud;
  attribute float aSize;
  attribute float aSeed;
  attribute float aDelay;

  uniform float uOpen;
  uniform float uTime;
  uniform float uPointScale;
  uniform float uOpacity;
  uniform vec3 uHand;
  uniform float uHandStrength;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float delay = aDelay * 0.58;
    float open = smoothstep(delay, delay + 0.55, uOpen);
    open = clamp(open, 0.0, 1.0);

    vec3 p = mix(position, aBloom, open);

    // Petals briefly lift toward the viewer mid-unfurl, like a breath.
    float lift = sin(open * 3.14159265) * (0.05 + aSeed * 0.09);
    p.z += lift;

    // Weightless idle motion, stronger once the flower is open.
    float phase = aSeed * 31.4 + uTime * 0.75;
    float sway = 0.007 + open * 0.012;
    p.x += sin(phase + p.y * 1.4) * sway;
    p.y += cos(phase * 1.17 + p.x * 1.1) * sway * 0.8;
    p.z += sin(phase * 0.7 + p.x * 2.0) * sway * 1.2;

    // Fingertip influence: a soft local push, not a magnet.
    vec3 toHand = p - uHand;
    float d = length(toHand);
    float influence = exp(-d * d * 2.35) * uHandStrength;
    p += normalize(toHand + vec3(0.0001)) * influence * (0.10 + open * 0.1);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);

    vColor = mix(aColorBud, aColorBloom, smoothstep(0.02, 0.94, open));
    float twinkle = 0.74 + 0.26 * sin(uTime * 1.35 + aSeed * 47.0);
    vAlpha = uOpacity * twinkle;

    float size = aSize * mix(0.78, 1.12, open);
    gl_PointSize = clamp(size * uPointScale / max(0.25, -mvPosition.z), 0.7, 15.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FLOWER_FRAG = /* glsl */ `
  precision highp float;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    float soft = smoothstep(0.5, 0.04, d);
    float core = smoothstep(0.28, 0.0, d);
    vec3 color = vColor * (0.5 + 0.95 * core * core);
    color += vec3(0.09, 0.025, 0.05) * soft;

    float alpha = vAlpha * soft * 0.86;
    gl_FragColor = vec4(color, alpha);
  }
`;

const DUST_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;
  attribute vec3 aColorDust;

  uniform float uTime;
  uniform float uOpen;
  uniform float uPointScale;
  uniform vec3 uHand;
  uniform float uHandStrength;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    float phase = aSeed * 21.0;

    p.x += sin(uTime * 0.26 + phase) * (0.16 + aSeed * 0.2);
    p.y += cos(uTime * 0.2 + phase * 1.3) * (0.12 + aSeed * 0.18);
    p.z += sin(uTime * 0.17 + phase * 0.8) * 0.22;

    // Pollen drifts outward as the flower opens.
    vec2 radial = normalize(p.xy + vec2(0.0001));
    p.xy += radial * uOpen * (0.08 + aSeed * 0.22);
    p.z += uOpen * (aSeed - 0.35) * 0.4;

    vec3 toHand = p - uHand;
    float d = length(toHand);
    p += normalize(toHand + vec3(0.0001)) * exp(-d * d * 1.5) * uHandStrength * 0.24;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    float twinkle = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * 1.4 + phase * 5.0), 2.0);

    vColor = aColorDust;
    vAlpha = twinkle * (0.35 + uOpen * 0.65);

    gl_PointSize = clamp(aSize * uPointScale / max(0.4, -mvPosition.z), 0.5, 6.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const DUST_FRAG = /* glsl */ `
  precision highp float;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * (0.8 + core), vAlpha * core * core);
  }
`;

const CORE_VERT = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CORE_FRAG = /* glsl */ `
  precision highp float;

  uniform float uOpen;
  uniform float uTime;
  uniform float uStrength;
  uniform vec3 uWarm;
  uniform vec3 uHot;

  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);

    // A warm heart, not a hard disc: two falls of light and a slow breath.
    float halo = exp(-r * r * 9.0) * 0.26;
    float heart = exp(-r * r * 30.0) * 0.3;
    float pulse = 0.92 + 0.08 * sin(uTime * 1.6);
    float a = (halo + heart) * uStrength * pulse;
    a *= smoothstep(1.0, 0.9, r);
    a *= 0.35 + 0.65 * uOpen;

    if (a < 0.004) discard;

    vec3 color = mix(uWarm, uHot, exp(-r * r * 7.0));
    gl_FragColor = vec4(color, a);
  }
`;

const AURA_VERT = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const AURA_FRAG = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uStrength;
  uniform float uOpen;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float angle = atan(p.y, p.x);

    // Mostly a soft fingertip light. The ring is only a ghost of an edge.
    float glow = exp(-r * r * 11.0) * 0.42;
    float core = exp(-r * r * 90.0) * 0.5;
    float ring = smoothstep(0.5, 0.545, r) * smoothstep(0.6, 0.56, r);
    float arcs = 0.2 + 0.8 * pow(0.5 + 0.5 * sin(angle * 3.0 + uTime * 0.9), 4.0);
    float spark = pow(0.5 + 0.5 * sin(angle * 11.0 - uTime * 1.7 + r * 5.0), 24.0)
                * smoothstep(0.32, 0.5, r) * smoothstep(0.62, 0.5, r);

    float a = (glow + core + ring * arcs * 0.16 + spark * 0.35) * uStrength;
    a *= 0.6 + 0.4 * uOpen;

    if (a < 0.004) discard;

    vec3 color = mix(uColorA, uColorB, 0.5 + 0.5 * sin(angle * 2.0 + uTime * 0.7));
    gl_FragColor = vec4(color, a);
  }
`;

/* ---------------------------------------------------------------- */
/* Geometry                                                          */
/* ---------------------------------------------------------------- */

function petalSurface(layer, petalIndex) {
  const theta = (petalIndex / layer.petals) * TAU + layer.tilt;
  const seed = range(0, 1);
  const widthJitter = range(0.92, 1.06);
  const lenJitter = range(0.94, 1.04);
  return { theta, seed, widthJitter, lenJitter };
}

function petalColor(layer, u, v, layerIndex, petalIndex) {
  const t = smoothstep(0.0, 1.0, u);
  const edgeT = smoothstep(0.52, 1.0, u) * 0.7 + Math.abs(v) * 0.2;

  // Each petal gets a slightly different relationship to the palette,
  // otherwise 18 petals read as one flat sheet.
  const variant = ((petalIndex * 7 + layerIndex * 3) % 9) / 8;
  const base = mixColor(C.bloomDeep, layer.edge[0], 0.55 + variant * 0.3);
  const tip = mixColor(layer.edge[1], layer.edge[2], variant * 0.6);
  let color = mixColor(base, tip, edgeT);

  // A pale luminous rim, kept restrained so the petal edges stay pink.
  color.lerp(C.bloomCream, smoothstep(0.86, 1.0, u) * 0.16);
  // The outer strand of each petal catches a little more light.
  color.lerp(C.bloomCream, smoothstep(0.9, 1.0, Math.abs(v)) * 0.42);
  return color;
}

function buildFlowerGeometry() {
  const positions = []; // bud shape
  const blooms = []; // open shape
  const colorsBloom = [];
  const colorsBud = [];
  const sizes = [];
  const seeds = [];
  const delays = [];

  const push = (bud, bloom, colorBloom, colorBud, size, seed, delay) => {
    positions.push(bud.x, bud.y, bud.z);
    blooms.push(bloom.x, bloom.y, bloom.z);
    colorsBloom.push(colorBloom.r, colorBloom.g, colorBloom.b);
    colorsBud.push(colorBud.r, colorBud.g, colorBud.b);
    sizes.push(size);
    seeds.push(seed);
    delays.push(delay);
  };

  LAYERS.forEach((layer, layerIndex) => {
    for (let petal = 0; petal < layer.petals; petal += 1) {
      const { theta, seed, widthJitter, lenJitter } = petalSurface(layer, petal);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);

      const strands = layer.strands || 9;

      for (let i = 0; i < layer.perPetal; i += 1) {
        // Stratified sampling along the petal, with a little jitter.
        const u = Math.pow((i + rand()) / layer.perPetal, 0.9);

        // Most particles sit on longitudinal filaments. That leaves thin
        // gaps between strands, so each petal reads as a petal instead of
        // dissolving into an even cloud.
        const fill = rand() < 0.14;
        let v;
        if (fill) {
          v = rand() * 2 - 1;
        } else {
          const strand = Math.floor(rand() * strands);
          v = (strand / (strands - 1)) * 2 - 1;
          v += (rand() - 0.5) * (0.24 / (strands - 1));
        }
        const rim = Math.abs(v) > 0.9;

        const profile = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.84)), 0.66);
        const width = layer.width * widthJitter * profile;
        const edgeWave = 1 + 0.075 * Math.sin(u * 9.0 + petal * 2.1);

        const lateral = v * width * edgeWave;
        const radial = layer.baseRadius + u * layer.length * lenJitter;

        // Open petal lives in the XY plane and cups toward the camera.
        const bloom = new THREE.Vector3(
          cos * radial - sin * lateral,
          sin * radial + cos * lateral,
          layer.z +
            layer.cup * v * v * (0.25 + 0.75 * u) +
            layer.curl * u * u +
            Math.sin(u * Math.PI) * layer.tilt * 0.25
        );

        // Closed petal wraps around the bud's vertical axis.
        const budU = Math.pow(u, 0.98);
        const wrapAngle =
          theta +
          v * ((TAU / layer.petals) * layer.wrap) +
          budU * 0.55 * (petal % 2 === 0 ? 1 : -1);

        const budProfile =
          Math.sin(Math.PI * (0.09 + budU * 0.84)) *
          (1 - 0.5 * smoothstep(0.64, 1.0, budU));
        const budRadius =
          layer.budRadius *
          (0.18 + 0.82 * budProfile) *
          (1 + 0.04 * Math.cos(v * 6.0)) *
          (1 + 0.045 * Math.sin(petal * 2.4));
        const bud = new THREE.Vector3(
          Math.cos(wrapAngle) * budRadius,
          layer.budY +
            budU * layer.budHeight +
            0.05 * Math.sin(budU * Math.PI) +
            0.022 * Math.sin(v * 4.0 + petal),
          Math.sin(wrapAngle) * budRadius
        );

        // The bud gathers to a fine, slightly folded point.
        const tipPinch = 1 - 0.78 * smoothstep(0.78, 1.0, budU);
        bud.x *= tipPinch;
        bud.z *= tipPinch;

        const bloomColor = petalColor(layer, u, v, layerIndex, petal);
        const budT = smoothstep(-0.1, 0.95, budU);
        const budColor = mixColor(C.budDeep, C.budWine, budT * 0.7 + 0.15);
        budColor.lerp(C.budRose, Math.abs(v) * 0.18 + 0.08);
        budColor.lerp(C.budTip, smoothstep(0.82, 1.0, budU) * 0.42);
        // Dark seams at every petal edge, so the closed layers read.
        budColor.lerp(C.budDeep, smoothstep(0.66, 0.98, Math.abs(v)) * 0.7);

        const size =
          layer.size *
          range(0.62, 1.25) *
          (0.75 + 0.35 * Math.sin(u * Math.PI)) *
          (rim ? 1.24 : 1.0);
        const delay =
          layer.delay[0] + (layer.delay[1] - layer.delay[0]) * (petal / layer.petals) +
          rand() * 0.025;
        const particleSeed = rand();

        push(bud, bloom, bloomColor, budColor, size, particleSeed, delay);
      }
    }
  });

  // ------------------------------------------------------------
  // Stamens: a dense gold heart that stays at the center of the bud.
  // ------------------------------------------------------------
  const stamenCount = 640;
  for (let i = 0; i < stamenCount; i += 1) {
    const theta = rand() * TAU;
    const radius = Math.sqrt(rand()) * 0.2;
    const z = 0.45 + Math.sqrt(rand()) * 0.18;
    const bloom = new THREE.Vector3(
      Math.cos(theta) * radius,
      Math.sin(theta) * radius,
      z
    );

    const bud = new THREE.Vector3(
      Math.cos(theta) * radius * 0.42,
      0.06 + rand() * 0.24,
      Math.sin(theta) * radius * 0.42
    );

    const bloomColor = mixColor(C.gold, C.goldPale, 0.35 + rand() * 0.65);
    const budColor = mixColor(C.goldDeep, C.gold, rand() * 0.5);
    const size = range(0.55, 1.05);
    push(bud, bloom, bloomColor, budColor, size, rand(), rand() * 0.1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute('aBloom', new THREE.Float32BufferAttribute(blooms, 3));
  geometry.setAttribute(
    'aColorBloom',
    new THREE.Float32BufferAttribute(colorsBloom, 3)
  );
  geometry.setAttribute(
    'aColorBud',
    new THREE.Float32BufferAttribute(colorsBud, 3)
  );
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setAttribute('aDelay', new THREE.Float32BufferAttribute(delays, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function buildDustGeometry() {
  const count = 720;
  const positions = [];
  const colors = [];
  const sizes = [];
  const seeds = [];

  for (let i = 0; i < count; i += 1) {
    // Shell distribution: sparse near the flower, thinning outward.
    const theta = rand() * TAU;
    const radius = 1.3 + Math.pow(rand(), 0.55) * 5.2;
    const y = (rand() * 2 - 1) * (1.6 + radius * 0.32);
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius * 0.75 + range(-0.6, 0.6);

    positions.push(x, y * 0.6 + 0.2, z);

    const warm = rand();
    const color = warm > 0.72
      ? mixColor(C.goldPale, C.bloomCream, rand())
      : mixColor(C.bloomBlush, C.bloomPink, rand());
    color.multiplyScalar(0.75 + rand() * 0.4);

    colors.push(color.r, color.g, color.b);
    sizes.push(range(0.45, 1.35));
    seeds.push(rand());
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aColorDust', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/* ---------------------------------------------------------------- */
/* Flower                                                            */
/* ---------------------------------------------------------------- */

export class Flower {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'flower';

    this.uniforms = {
      uOpen: { value: 0 },
      uTime: { value: 0 },
      uPointScale: { value: 900 },
      uOpacity: { value: 0.9 },
      uHand: { value: new THREE.Vector3(0, 0, 2.4) },
      uHandStrength: { value: 0 },
    };

    this.geometry = buildFlowerGeometry();
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: FLOWER_VERT,
      fragmentShader: FLOWER_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.group.add(this.points);

    this.dustUniforms = {
      uTime: { value: 0 },
      uOpen: { value: 0 },
      uPointScale: { value: 900 },
      uHand: { value: new THREE.Vector3(0, 0, 2.4) },
      uHandStrength: { value: 0 },
    };
    this.dustGeometry = buildDustGeometry();
    this.dustMaterial = new THREE.ShaderMaterial({
      uniforms: this.dustUniforms,
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(this.dustGeometry, this.dustMaterial);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 1;
    this.group.add(this.dust);

    // A soft gold heart behind the filaments, so the flower never reads hollow.
    this.coreUniforms = {
      uOpen: { value: 0 },
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uWarm: { value: new THREE.Color('#ff965e') },
      uHot: { value: new THREE.Color('#ffd684') },
    };
    this.coreMaterial = new THREE.ShaderMaterial({
      uniforms: this.coreUniforms,
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.core = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), this.coreMaterial);
    this.core.position.set(0, 0, 0.72);
    this.core.renderOrder = 0;
    this.group.add(this.core);

    // Fingertip halo, kept in world space so it always faces the camera.
    this.auraUniforms = {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uOpen: { value: 0 },
      uColorA: { value: new THREE.Color('#ff86b7') },
      uColorB: { value: new THREE.Color('#ffd6a4') },
    };
    this.auraMaterial = new THREE.ShaderMaterial({
      uniforms: this.auraUniforms,
      vertexShader: AURA_VERT,
      fragmentShader: AURA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.aura = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.64), this.auraMaterial);
    this.aura.frustumCulled = false;
    this.aura.renderOrder = 4;
    this.aura.visible = false;

    this._open = 0;
    this._targetOpen = 0;
    this._handStrength = 0;
    this._handWorld = new THREE.Vector3(0, 0, 1.8);
    this._handLocal = new THREE.Vector3(0, 0, 1.8);
    this._sway = { x: 0, y: 0 };
    this._pointer = new THREE.Vector2();
    this._lean = { x: 0, y: 0 };

    this._tmp = new THREE.Vector3();
    this._baseRotation = new THREE.Euler(0, 0, 0);
  }

  addTo(scene) {
    scene.add(this.group);
    scene.add(this.aura);
    return this;
  }

  /**
   * Keep point size proportional to the drawing buffer and camera FOV.
   * @param {THREE.PerspectiveCamera} camera
   * @param {number} drawingBufferHeight
   */
  setViewport(camera, drawingBufferHeight) {
    // aSize is authored around 1.0; this constant lands a typical petal
    // particle at ~2–4 CSS pixels on a 1000px-tall buffer.
    const scale = drawingBufferHeight * 0.026;
    this.uniforms.uPointScale.value = scale;
    this.dustUniforms.uPointScale.value = scale;
  }

  setOpen(value) {
    this._targetOpen = Math.min(1, Math.max(0, value));
  }

  /** A very small full-body lean toward the hand, in radians. */
  setLean(x, y) {
    this._lean.x = x;
    this._lean.y = y;
  }

  setHandWorld(point, strength = 1) {
    this._handWorld.copy(point);
    this._handStrength = strength;
    this.aura.position.copy(point);
    this.aura.visible = strength > 0.01;
  }

  /** Call once per frame after camera/group transforms are settled. */
  update(dt, time) {
    this._open = THREE.MathUtils.damp(this._open, this._targetOpen, 7.5, Math.min(dt, 0.05));
    this.uniforms.uOpen.value = this._open;
    this.uniforms.uTime.value = time;
    this.dustUniforms.uOpen.value = this._open;
    this.dustUniforms.uTime.value = time;

    this.coreUniforms.uOpen.value = this._open;
    this.coreUniforms.uTime.value = time;
    this.coreUniforms.uStrength.value = 0.1 + 0.24 * this._open;
    const coreScale = 0.8 + 0.2 * this._open;
    this.core.scale.set(coreScale, coreScale, 1);

    this.auraUniforms.uTime.value = time;
    this.auraUniforms.uOpen.value = this._open;
    this.auraUniforms.uStrength.value = THREE.MathUtils.damp(
      this.auraUniforms.uStrength.value,
      this._handStrength,
      8,
      Math.min(dt, 0.05)
    );

    this.group.rotation.x =
      this._lean.x + Math.sin(time * 0.17 + 1.3) * 0.02;
    this.group.rotation.y = this._lean.y;
    this.group.rotation.z = Math.sin(time * 0.21) * 0.018;
    this.group.updateMatrixWorld();

    this._handLocal.copy(this._handWorld);
    this.group.worldToLocal(this._handLocal);
    this.uniforms.uHand.value.copy(this._handLocal);
    this.uniforms.uHandStrength.value = THREE.MathUtils.damp(
      this.uniforms.uHandStrength.value,
      this._handStrength,
      6,
      Math.min(dt, 0.05)
    );
    this.dustUniforms.uHand.value.copy(this._handLocal);
    this.dustUniforms.uHandStrength.value = this.uniforms.uHandStrength.value;

    if (this.aura.visible) {
      const pulse = 1 + Math.sin(time * 1.9) * 0.055;
      this.aura.scale.setScalar(pulse);
      this.aura.quaternion.copy(this._cameraQuaternion || new THREE.Quaternion());
    }
  }

  /** Aura needs the camera quaternion each frame to remain billboarded. */
  faceCamera(camera) {
    this._cameraQuaternion = camera.quaternion;
    if (this.aura.visible) this.aura.quaternion.copy(camera.quaternion);
  }

  get open() {
    return this._open;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.dustGeometry.dispose();
    this.dustMaterial.dispose();
    this.core.geometry.dispose();
    this.coreMaterial.dispose();
    this.aura.geometry.dispose();
    this.auraMaterial.dispose();
  }
}
