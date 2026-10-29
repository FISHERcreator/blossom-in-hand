/**
 * main.js
 * ------------------------------------------------------------
 * Scene assembly, camera-free demo, and the bridge between the hand
 * tracker and the flower's uniforms.
 *
 * Modes:
 *   entry  – the opening card is visible; the flower breathes behind it
 *   camera – MediaPipe drives the bloom
 *   demo   – an authored hand path drives the bloom, no camera needed
 */

import * as THREE from 'three';
import { Flower } from './flower.js';
import { PostFX } from './postfx.js';
import { HandTracker } from './hand-tracker.js';
import { GestureSmoother } from './gesture.js';

const $ = (id) => document.getElementById(id);

const dom = {
  body: document.body,
  stage: $('stage'),
  canvas: $('world'),
  entry: $('entry'),
  startButton: $('start-button'),
  demoButton: $('demo-button'),
  entryHelp: $('entry-help'),
  helpButton: $('help-button'),
  helpDialog: $('help-dialog'),
  helpClose: $('help-close'),
  dialogDemo: $('dialog-demo'),
  cameraPanel: $('camera-panel'),
  video: $('camera-video'),
  handCanvas: $('hand-canvas'),
  cameraStatus: $('camera-status'),
  cameraTime: $('camera-time'),
  cameraRetry: $('camera-retry'),
  handLock: $('hand-lock'),
  cameraPlaceholder: $('camera-placeholder'),
  systemState: $('system-state'),
  systemLabel: $('system-label'),
  readout: $('readout'),
  stateKicker: $('state-kicker'),
  stateTitle: $('state-title'),
  stateDesc: $('state-desc'),
  openPercent: $('open-percent'),
  meter: $('meter'),
  loadingLayer: $('loading-layer'),
  loadingText: $('loading-text'),
  toast: $('toast'),
  toastText: $('toast-text'),
};

const COPY = {
  wait: {
    kicker: 'PETAL STATE / LISTEN',
    title: '等待',
    desc: '把手放进右上角画面。握拳或张开手掌，花会读懂你。',
  },
  closed: {
    kicker: 'PETAL STATE / SLEEP',
    title: '花苞',
    desc: '握紧手指，让它收拢成苞。再一次张开，会更慢一点。',
  },
  half: {
    kicker: 'PETAL STATE / BETWEEN',
    title: '半绽',
    desc: '花瓣停在半途，像一次没有说完的呼吸。再张开一点，光会继续向外。',
  },
  open: {
    kicker: 'PETAL STATE / BLOOM',
    title: '绽放',
    desc: '掌心舒展，花瓣正沿光向外铺开。移动手掌，花会跟着倾斜。',
  },
};

const query = new URLSearchParams(window.location.search);
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let mode = 'entry';
let entered = false;
let startingCamera = false;
let cameraStartedAt = 0;
let lastClockPaint = 0;
let lastFrame = performance.now();
let time = 0;
let demoClock = 0;
let toastTimer = 0;
let failureToastShown = false;

const pointer = new THREE.Vector2(0.5, 0.5);
let pointerActive = false;

const handSmooth = new THREE.Vector3();
let handSmoothReady = false;
const handTarget = new THREE.Vector3();
const pointerWorld = new THREE.Vector3();
let auraStrength = 0;
let leanX = 0;
let leanY = 0;

const smoother = new GestureSmoother({
  openThreshold: 0.6,
  closeThreshold: 0.34,
  attack: 9,
  release: 5,
});

/* ---------------------------------------------------------------- */
/* Renderer / scene                                                  */
/* ---------------------------------------------------------------- */

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: dom.canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
  });
} catch (error) {
  console.error('[main] WebGL renderer failed', error);
  showFatalWebGL();
}

if (renderer) {
  boot();
}

function boot() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#05020a');

  const camera = new THREE.PerspectiveCamera(
    window.innerWidth / window.innerHeight < 0.8 ? 50 : 38,
    window.innerWidth / window.innerHeight,
    0.1,
    120
  );

  const flower = new Flower();
  flower.addTo(scene);
  flower.setOpen(0.06);

  const postfx = new PostFX(renderer);

  const tracker = new HandTracker({
    video: dom.video,
    canvas: dom.handCanvas,
    onStatus: handleTrackerStatus,
    onStream: handleStreamState,
  });

  function resize() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const aspect = width / height;
    const portrait = aspect < 0.8;
    const dpr = Math.min(window.devicePixelRatio || 1, portrait ? 1.6 : 1.75);

    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);

    camera.aspect = aspect;
    camera.fov = portrait ? 50 : 38;
    camera.updateProjectionMatrix();

    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const targetHeight = portrait ? 5.4 : 5.55;
    const targetWidth = portrait ? 4.9 : 5.35;
    const fitHeight = targetHeight / (2 * tan);
    const fitWidth = targetWidth / (2 * tan * aspect);
    const distance = Math.max(fitHeight, fitWidth) * 1.035;

    camera.position.set(0, 0.12, distance);
    camera.lookAt(0, 0.02, 0);
    camera.updateMatrixWorld();

    flower.group.position.set(0, portrait ? 0.42 : 0.02, 0);
    flower.group.updateMatrixWorld();

    postfx.setSize(width, height, dpr);
    flower.setViewport(camera, renderer.domElement.height);
  }

  resize();
  window.addEventListener('resize', resize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resize, { passive: true });
  }

  /* -------------------------------------------------------------- */
  /* Hand → world mapping                                           */
  /* -------------------------------------------------------------- */

  const raycasterNdc = new THREE.Vector3();

  function screenToWorld(nx, ny, planeZ = 0.9, out = new THREE.Vector3()) {
    camera.updateMatrixWorld();
    raycasterNdc.set(nx * 2 - 1, -(ny * 2 - 1), 0.5);
    raycasterNdc.unproject(camera);
    raycasterNdc.sub(camera.position).normalize();
    if (Math.abs(raycasterNdc.z) < 1e-5) return out.set(0, 0, planeZ);
    const t = (planeZ - camera.position.z) / raycasterNdc.z;
    out.copy(camera.position).addScaledVector(raycasterNdc, t);
    return out;
  }

  function handAnatomyToWorld(analysis, out) {
    const tip = analysis.indexTip;
    // The preview is mirrored; mirror the scene mapping to match.
    const nx = 1 - tip.x;
    const ny = tip.y;
    screenToWorld(nx, ny, 0.95, out);
    out.x = THREE.MathUtils.clamp(out.x, -3.8, 3.8);
    out.y = THREE.MathUtils.clamp(out.y, -3.0, 3.1);
    return out;
  }

  /* -------------------------------------------------------------- */
  /* Camera / tracker UI                                            */
  /* -------------------------------------------------------------- */

  function handleTrackerStatus(payload) {
    dom.cameraStatus.textContent = payload.message || '';

    if (payload.state === 'error') {
      dom.cameraPanel.classList.add('has-error');
      dom.body.classList.remove('is-tracking');
      if (!failureToastShown) {
        failureToastShown = true;
        showToast('摄像头不可用，已转入自动演示');
      }
    } else {
      dom.cameraPanel.classList.remove('has-error');
    }

    if (payload.state === 'tracking') {
      dom.body.classList.add('is-tracking');
    } else if (payload.state === 'searching' || payload.state === 'idle') {
      dom.body.classList.remove('is-tracking');
    }
  }

  function handleStreamState(active) {
    dom.cameraPanel.classList.toggle('is-streaming', active);
    if (active) {
      cameraStartedAt = performance.now();
      dom.cameraTime.textContent = '00:00';
      dom.cameraPanel.classList.remove('has-error');
      dom.cameraPlaceholder.lastElementChild.textContent = '等待授权摄像头';
    } else {
      dom.cameraTime.textContent = '00:00';
      if (mode === 'demo') {
        dom.cameraPlaceholder.lastElementChild.textContent = '自动演示中 · 摄像头关闭';
      }
    }
  }

  function setLoading(visible, message = '正在唤醒摄像头与手势模型…') {
    dom.loadingText.textContent = message;
    dom.loadingLayer.classList.toggle('is-visible', visible);
    dom.loadingLayer.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function enterExperience() {
    if (entered) return;
    entered = true;
    dom.entry.classList.add('is-hidden');
    dom.entry.setAttribute('aria-hidden', 'true');
    dom.body.classList.remove('is-entry');
    dom.body.classList.add('is-experience');
    dom.startButton.blur();
    dom.demoButton.blur();
  }

  function setMode(next) {
    mode = next;
    dom.body.dataset.mode = next;
    dom.body.classList.toggle('is-demo', next === 'demo');
    if (next === 'camera') {
      dom.systemLabel.textContent = '寻找手部';
    } else if (next === 'demo') {
      dom.systemLabel.textContent = '自动演示';
    }
  }

  async function startCamera({ retry = false } = {}) {
    if (startingCamera) return;
    if (tracker.active && mode === 'camera') return;

    startingCamera = true;
    failureToastShown = false;
    dom.cameraRetry.disabled = true;
    dom.cameraPanel.classList.remove('has-error');

    if (!retry) {
      setLoading(true, '正在唤醒摄像头与手势模型…');
    } else {
      dom.cameraStatus.textContent = '正在重试摄像头…';
      dom.cameraPanel.classList.remove('has-error');
    }

    const ok = await tracker.start();
    startingCamera = false;
    dom.cameraRetry.disabled = false;

    if (ok) {
      setLoading(false);
      setMode('camera');
      enterExperience();
      smoother.reset();
      handSmoothReady = false;
      dom.body.classList.remove('is-demo');
      showToast('手势已就绪 · 握拳或张开手掌');
    } else {
      setLoading(false);
      if (!entered) enterExperience();
      startDemo({ auto: true, fromFailure: true });
      if (!retry) {
        dom.cameraStatus.textContent = tracker.error?.message || '摄像头启动失败';
      }
    }
  }

  function startDemo({ auto = false, fromFailure = false } = {}) {
    setLoading(false);
    if (tracker.active) tracker.stop();
    setMode('demo');
    enterExperience();
    smoother.reset();
    demoClock = 0;
    handSmoothReady = false;
    dom.cameraPanel.classList.remove('is-locked', 'has-error');
    if (!tracker.active) {
      dom.cameraPlaceholder.lastElementChild.textContent = '自动演示中 · 摄像头关闭';
      dom.cameraStatus.textContent = '自动演示中 · 摄像头未开启';
    }
    if (!auto && !fromFailure) {
      showToast('自动演示已开始 · 移动鼠标感受粒子');
    }
  }

  function showToast(text, duration = 3400) {
    window.clearTimeout(toastTimer);
    dom.toastText.textContent = text;
    dom.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => {
      dom.toast.classList.remove('is-visible');
    }, duration);
  }

  /* -------------------------------------------------------------- */
  /* Demo choreography                                              */
  /* -------------------------------------------------------------- */

  function demoOpen(t) {
    // A slow inhale / exhale: holds near closed, then near full bloom.
    const wave = 0.5 + 0.5 * Math.sin(t * 0.54 + 0.4);
    return THREE.MathUtils.smoothstep(wave, 0.12, 0.9);
  }

  function demoHand(t, out) {
    out.set(
      Math.cos(t * 0.42) * 2.35,
      0.25 + Math.sin(t * 0.58) * 1.55,
      0.95 + Math.sin(t * 0.31) * 0.2
    );
    return out;
  }

  /* -------------------------------------------------------------- */
  /* UI reads                                                       */
  /* -------------------------------------------------------------- */

  const lastUi = {
    percent: -1,
    title: '',
    kicker: '',
    desc: '',
    legend: '',
    present: null,
    system: '',
  };

  function updateReadout(open, present) {
    const percent = Math.round(Math.min(1, Math.max(0, open)) * 100);
    dom.readout.style.setProperty('--bloom', (open).toFixed(3));

    if (percent !== lastUi.percent) {
      lastUi.percent = percent;
      dom.openPercent.textContent = String(percent).padStart(2, '0');
      dom.meter.setAttribute('aria-valuenow', String(percent));
    }

    let key = 'wait';
    if (present) {
      key = open > 0.62 ? 'open' : open > 0.22 ? 'half' : 'closed';
    }
    const copy = COPY[key];

    if (key !== lastUi.title) {
      lastUi.title = key;
      dom.readout.dataset.state = key;
      dom.stateTitle.textContent = copy.title;
    }
    if (copy.kicker !== lastUi.kicker) {
      lastUi.kicker = copy.kicker;
      dom.stateKicker.textContent = copy.kicker;
    }
    if (copy.desc !== lastUi.desc) {
      lastUi.desc = copy.desc;
      dom.stateDesc.textContent = copy.desc;
    }

    if (present !== lastUi.present) {
      lastUi.present = present;
      dom.body.classList.toggle('is-tracking', present && mode === 'camera');
      dom.cameraPanel.classList.toggle('is-locked', present && mode === 'camera');
    }

    const legend = present ? (open > 0.5 ? 'open' : 'closed') : '';
    if (legend !== lastUi.legend) {
      lastUi.legend = legend;
      document.querySelectorAll('.legend-item').forEach((item) => {
        item.classList.toggle('is-active', item.dataset.legend === legend);
      });
    }

    let system = '待唤醒';
    if (mode === 'demo') system = '自动演示';
    else if (mode === 'camera') {
      system = present ? '手势在线' : tracker.active ? '寻找手部' : '摄像头离线';
    }
    if (system !== lastUi.system) {
      lastUi.system = system;
      dom.systemLabel.textContent = system;
    }
  }

  function paintClock(now) {
    if (now - lastClockPaint < 480) return;
    lastClockPaint = now;
    if (!tracker.active || !cameraStartedAt) {
      dom.cameraTime.textContent = '00:00';
      return;
    }
    const total = Math.max(0, Math.floor((now - cameraStartedAt) / 1000));
    const minutes = String(Math.floor(total / 60)).padStart(2, '0');
    const seconds = String(total % 60).padStart(2, '0');
    dom.cameraTime.textContent = `${minutes}:${seconds}`;
  }

  /* -------------------------------------------------------------- */
  /* Frame loop                                                     */
  /* -------------------------------------------------------------- */

  function frame(now) {
    requestAnimationFrame(frame);

    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    time += dt;
    demoClock += dt;

    let present = false;

    if (mode === 'demo') {
      const demo = demoOpen(demoClock);
      smoother.update({ openness: demo, pinch: 0 }, dt, now * 0.001);
      present = true;
      demoHand(demoClock, handTarget);
      auraStrength = 0.55;
    } else if (mode === 'camera' && tracker.active) {
      const analysis = tracker.currentAnalysis;
      smoother.update(analysis, dt, now * 0.001);
      present = Boolean(analysis);
      if (analysis) {
        handAnatomyToWorld(analysis, handTarget);
        auraStrength = 0.55 + analysis.pinch * 0.2;
      } else {
        auraStrength = 0;
      }
    } else {
      smoother.update(null, dt, now * 0.001);
      present = false;
      auraStrength = 0;
    }

    // Pointer fallback: when there is no hand, the flower still answers
    // the cursor, so the scene never feels frozen.
    if (!present && pointerActive && mode !== 'demo') {
      screenToWorld(pointer.x, pointer.y, 1.0, pointerWorld);
      pointerWorld.x = THREE.MathUtils.clamp(pointerWorld.x, -3.6, 3.6);
      pointerWorld.y = THREE.MathUtils.clamp(pointerWorld.y, -2.8, 2.9);
      if (auraStrength < 0.28) auraStrength = 0.28;
      handTarget.copy(pointerWorld);
    }

    const open = smoother.value;
    flower.setOpen(open);

    if (auraStrength > 0.005) {
      if (!handSmoothReady) {
        handSmooth.copy(handTarget);
        handSmoothReady = true;
      } else {
        handSmooth.lerp(handTarget, 1 - Math.exp(-11 * dt));
      }
    }

    const leanTargetX = THREE.MathUtils.clamp(-(handSmooth.y - flower.group.position.y) * 0.018, -0.065, 0.065);
    const leanTargetY = THREE.MathUtils.clamp(handSmooth.x * 0.024, -0.085, 0.085);
    leanX = THREE.MathUtils.damp(leanX, auraStrength > 0.02 ? leanTargetX : 0, 4, dt);
    leanY = THREE.MathUtils.damp(leanY, auraStrength > 0.02 ? leanTargetY : 0, 4, dt);
    flower.setLean(leanX, leanY);

    flower.faceCamera(camera);
    flower.setHandWorld(handSmooth, auraStrength);
    flower.update(dt, time);

    updateReadout(open, present);
    paintClock(now);
    postfx.render(scene, camera, time);

    if (!entered) {
      // First frame is safely on screen; lift the canvas fade.
      dom.body.classList.add('is-scene-ready');
    }
  }

  requestAnimationFrame(frame);

  /* -------------------------------------------------------------- */
  /* Input                                                          */
  /* -------------------------------------------------------------- */

  dom.startButton.addEventListener('click', () => startCamera());
  dom.demoButton.addEventListener('click', () => startDemo());
  dom.cameraRetry.addEventListener('click', () => startCamera({ retry: true }));
  dom.dialogDemo.addEventListener('click', () => {
    closeHelp();
    startDemo();
  });

  dom.entryHelp.addEventListener('click', openHelp);
  dom.helpButton.addEventListener('click', openHelp);
  dom.helpClose.addEventListener('click', closeHelp);
  dom.helpDialog.addEventListener('click', (event) => {
    if (event.target === dom.helpDialog) closeHelp();
  });

  window.addEventListener('pointermove', (event) => {
    pointer.x = event.clientX / Math.max(1, window.innerWidth);
    pointer.y = event.clientY / Math.max(1, window.innerHeight);
    pointerActive = true;
  }, { passive: true });

  window.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.key === 'Escape' && dom.helpDialog.open) {
      closeHelp();
      return;
    }
    if ((event.key === 'd' || event.key === 'D') && !dom.helpDialog.open) {
      event.preventDefault();
      startDemo();
    }
  });

  function openHelp() {
    if (!dom.helpDialog.open) dom.helpDialog.showModal();
  }

  function closeHelp() {
    if (dom.helpDialog.open) dom.helpDialog.close();
  }

  // Keep the demo / camera state reachable from the console and for
  // automated visual checks.
  window.__blossom = {
    get mode() {
      return mode;
    },
    get open() {
      return smoother.value;
    },
    get present() {
      return Boolean(tracker.currentAnalysis);
    },
    startDemo,
    startCamera,
    flower,
    scene,
    camera,
    renderer,
    postfx,
    tracker,
  };

  /* -------------------------------------------------------------- */
  /* Intro / URL options                                            */
  /* -------------------------------------------------------------- */

  const demoParam = query.get('demo') === '1' || query.get('demo') === 'true';
  if (demoParam) {
    window.setTimeout(() => startDemo({ auto: true }), prefersReducedMotion ? 200 : 650);
  }
}

/* ---------------------------------------------------------------- */
/* Fatal fallback                                                   */
/* ---------------------------------------------------------------- */

function showFatalWebGL() {
  dom.loadingLayer.classList.remove('is-visible');
  const lede = document.querySelector('.entry-lede');
  if (lede) {
    lede.innerHTML =
      '这个浏览器暂时无法建立 WebGL 场景。<br />请尝试更新 Chrome / Edge，或在支持硬件加速的设备上打开。';
  }
  dom.startButton.disabled = true;
  dom.demoButton.disabled = true;
  if (dom.systemLabel) dom.systemLabel.textContent = 'WebGL 不可用';
}
