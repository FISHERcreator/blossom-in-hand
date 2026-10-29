/**
 * hand-tracker.js
 * ------------------------------------------------------------
 * Camera + MediaPipe Tasks Vision wrapper.
 *
 * Responsibilities:
 *  - load the local HandLandmarker (GPU, then CPU fallback)
 *  - own the webcam stream lifecycle
 *  - run detection at a measured cadence
 *  - paint the 21-point skeleton into the preview canvas
 *
 * The renderer pulls `tracker.analysis` each animation frame instead of
 * being driven by detection events, so the flower keeps 60fps even when
 * inference runs at ~30fps.
 */

import { HAND_CONNECTIONS, analyzeHand, clamp } from './gesture.js';

const DEFAULTS = {
  wasmPath: './vendor/mediapipe/wasm',
  modelPath: './models/hand_landmarker.task',
  minDetectionConfidence: 0.55,
  minPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  maxHands: 1,
};

const ERROR_COPY = {
  insecure: '摄像头需要 HTTPS 或 localhost 环境',
  permission: '摄像头权限被拒绝，可在地址栏重新授权',
  notfound: '没有找到可用的摄像头',
  busy: '摄像头正被其他应用占用',
  model: '手部模型加载失败，请检查 vendor 与 models 目录',
  mediapipe: 'MediaPipe 初始化失败，请确认浏览器支持 WebGL',
  aborted: '摄像头启动被中断',
  unknown: '摄像头启动失败',
};

export class HandTracker {
  /**
   * @param {{
   *   video: HTMLVideoElement,
   *   canvas: HTMLCanvasElement,
   *   onStatus?: (payload: {state:string, message:string, code?:string}) => void,
   *   onStream?: (active:boolean) => void,
   *   wasmPath?: string,
   *   modelPath?: string,
   * }} options
   */
  constructor(options) {
    this.video = options.video;
    this.canvas = options.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.onStatus = options.onStatus || (() => {});
    this.onStream = options.onStream || (() => {});

    this.wasmPath = options.wasmPath || DEFAULTS.wasmPath;
    this.modelPath = options.modelPath || DEFAULTS.modelPath;

    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.starting = false;
    this.analysis = null;
    this.lastSeenAt = -Infinity;
    this.lastDetectionAt = -Infinity;
    this.lastVideoTime = -1;
    this.handedness = '';
    this.error = null;

    this._raf = 0;
    this._lastDetect = 0;
    this._detectEvery = 30; // ms, inference throttle
    this._lastPresence = null;
    this._statusKey = '';
    this._dpr = 1;
    this._w = 0;
    this._h = 0;
    this._resizeObserver = null;
    this._fps = 0;
    this._frames = 0;
    this._fpsMark = 0;
  }

  get active() {
    return this.running;
  }

  get handPresent() {
    return performance.now() - this.lastSeenAt < 420;
  }

  get fps() {
    return Math.round(this._fps);
  }

  /** Latest analysis if the hand was seen very recently, else null. */
  get currentAnalysis() {
    return this.handPresent ? this.analysis : null;
  }

  /** Load MediaPipe. Safe to await before the user starts the camera. */
  async init() {
    if (this.landmarker) return this.landmarker;

    let FilesetResolver;
    let HandLandmarker;
    try {
      const vision = await import('@mediapipe/tasks-vision');
      FilesetResolver = vision.FilesetResolver;
      HandLandmarker = vision.HandLandmarker;
    } catch (error) {
      console.error('[hand-tracker] MediaPipe module failed to load', error);
      throw Object.assign(new Error(ERROR_COPY.mediapipe), {
        code: 'mediapipe',
        cause: error,
      });
    }

    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(this.wasmPath);
    } catch (error) {
      console.error('[hand-tracker] wasm fileset failed', error);
      throw Object.assign(new Error(ERROR_COPY.model), {
        code: 'model',
        cause: error,
      });
    }

    const baseOptions = {
      modelAssetPath: this.modelPath,
      delegate: 'GPU',
    };

    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions,
        runningMode: 'VIDEO',
        numHands: DEFAULTS.maxHands,
        minHandDetectionConfidence: DEFAULTS.minDetectionConfidence,
        minHandPresenceConfidence: DEFAULTS.minPresenceConfidence,
        minTrackingConfidence: DEFAULTS.minTrackingConfidence,
      });
    } catch (gpuError) {
      console.warn('[hand-tracker] GPU delegate unavailable, retrying CPU', gpuError);
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { ...baseOptions, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numHands: DEFAULTS.maxHands,
          minHandDetectionConfidence: DEFAULTS.minDetectionConfidence,
          minHandPresenceConfidence: DEFAULTS.minPresenceConfidence,
          minTrackingConfidence: DEFAULTS.minTrackingConfidence,
        });
      } catch (cpuError) {
        console.error('[hand-tracker] model creation failed', cpuError);
        throw Object.assign(new Error(ERROR_COPY.model), {
          code: 'model',
          cause: cpuError,
        });
      }
    }

    this._observeSize();
    return this.landmarker;
  }

  async start() {
    if (this.running || this.starting) return true;
    this.starting = true;
    this.error = null;

    try {
      await this.init();

      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error(ERROR_COPY.insecure), {
          code: window.isSecureContext ? 'unknown' : 'insecure',
        });
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 60 },
          },
        });
      } catch (error) {
        const name = error?.name || '';
        const code =
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'permission'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'notfound'
              : name === 'NotReadableError' || name === 'AbortError'
                ? 'busy'
                : 'unknown';
        throw Object.assign(new Error(ERROR_COPY[code]), { code, cause: error });
      }

      this.stream = stream;
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;

      await new Promise((resolve) => {
        if (this.video.readyState >= 2) {
          resolve();
          return;
        }
        const onReady = () => {
          this.video.removeEventListener('loadeddata', onReady);
          resolve();
        };
        this.video.addEventListener('loadeddata', onReady, { once: true });
        // Some browsers refuse to fire loadeddata on a background tab;
        // don't hang the whole experience on it.
        setTimeout(resolve, 2500);
      });

      try {
        await this.video.play();
      } catch (error) {
        // Autoplay of a muted camera stream is generally allowed, but a
        // manual retry from the UI can recover if it isn't.
        console.warn('[hand-tracker] video.play() rejected', error);
      }

      this.running = true;
      this.starting = false;
      this.onStream(true);
      this._setStatus('searching', '正在寻找手部 · show your hand');
      this._loop();
      return true;
    } catch (error) {
      this.starting = false;
      this.error = error;
      // A blocked camera is an expected, handled state — not a crash.
      const handled = ['permission', 'notfound', 'busy', 'insecure'].includes(error.code);
      (handled ? console.warn : console.error)('[hand-tracker] start failed', error);
      this._setStatus('error', error.message || ERROR_COPY.unknown, error.code);
      this._stopStream();
      this.onStream(false);
      this._clearCanvas();
      return false;
    }
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._stopStream();
    this._clearCanvas();
    this.analysis = null;
    this.lastSeenAt = -Infinity;
    this.onStream(false);
    this._setStatus('idle', '摄像头已关闭');
  }

  async dispose() {
    this.stop();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this.landmarker) {
      try {
        await this.landmarker.close();
      } catch {
        /* already gone */
      }
      this.landmarker = null;
    }
  }

  _stopStream() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video.srcObject) this.video.srcObject = null;
  }

  _setStatus(state, message, code = '') {
    const key = `${state}|${message}`;
    if (key === this._statusKey) return;
    this._statusKey = key;
    this.onStatus({ state, message, code });
  }

  _loop = () => {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);

    const now = performance.now();
    if (
      this.video.readyState >= 2 &&
      !this.video.paused &&
      now - this._lastDetect >= this._detectEvery
    ) {
      this._lastDetect = now;
      this._detect(now);
    }

    this._draw(now);
  };

  _detect(now) {
    if (!this.landmarker) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, now);
    } catch (error) {
      console.warn('[hand-tracker] detect failed', error);
      return;
    }

    const landmarks = result?.landmarks?.[0];
    const aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);

    if (landmarks && landmarks.length >= 21) {
      const analysis = analyzeHand(landmarks, aspect);
      if (analysis) {
        this.analysis = analysis;
        this.lastSeenAt = now;
        this.lastDetectionAt = now;
        this.handedness = result.handedness?.[0]?.[0]?.categoryName || '';
        this._reportPresence(true);
        return;
      }
    }

    if (now - this.lastSeenAt > 420) {
      this.analysis = null;
      this._reportPresence(false);
    }
  }

  _reportPresence(present) {
    if (this._lastPresence === present) return;
    this._lastPresence = present;
    if (present) {
      this._setStatus('tracking', '手部已捕捉 · hand locked');
    } else if (this.running) {
      this._setStatus('searching', '正在寻找手部 · show your hand');
    }
  }

  _observeSize() {
    const resize = () => {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (w === this.canvas.width && h === this.canvas.height) return;
      this.canvas.width = w;
      this.canvas.height = h;
      this._dpr = dpr;
      this._w = w;
      this._h = h;
    };

    resize();
    if ('ResizeObserver' in window) {
      this._resizeObserver = new ResizeObserver(resize);
      this._resizeObserver.observe(this.canvas);
    } else {
      window.addEventListener('resize', resize);
    }
  }

  _clearCanvas() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _draw(now) {
    if (!this.ctx) return;
    this._clearCanvas();

    if (!this.analysis?.landmarks) return;
    const age = now - this.lastDetectionAt;
    if (age > 520) return;
    const fade = age < 240 ? 1 : 1 - clamp((age - 240) / 280);

    this._paintSkeleton(this.analysis.landmarks, now, fade);
  }

  _paintSkeleton(landmarks, now, alpha = 1) {
    const ctx = this.ctx;
    if (!ctx) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return;
    const dpr = this._dpr;

    // The preview uses object-fit: cover. Mirror it, then apply the same
    // crop so the skeleton sits exactly on the filmed hand.
    const videoAspect =
      (this.video?.videoWidth || 4) / (this.video?.videoHeight || 3);
    const frameAspect = w / h;
    let sx = 1;
    let sy = 1;
    let ox = 0;
    let oy = 0;
    if (videoAspect > frameAspect) {
      const visible = frameAspect / videoAspect;
      sy = 1 / visible;
      oy = (1 - visible) * 0.5;
    } else {
      const visible = videoAspect / frameAspect;
      sx = 1 / visible;
      ox = (1 - visible) * 0.5;
    }
    const cover = Math.max(sx, sy);
    const px = (p) => ({
      x: ((1 - p.x - ox) * sx) * w,
      y: ((p.y - oy) * sy) * h,
    });

    const points = landmarks.map(px);
    const t = now * 0.001;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Soft palm light.
    const palm = points[9];
    const glowRadius = Math.max(
      28,
      (this.analysis?.palmSize || 0.1) * h * 1.15 * cover
    );
    const glow = ctx.createRadialGradient(
      palm.x,
      palm.y,
      0,
      palm.x,
      palm.y,
      glowRadius
    );
    glow.addColorStop(0, 'rgba(255, 110, 165, 0.18)');
    glow.addColorStop(0.55, 'rgba(255, 110, 165, 0.06)');
    glow.addColorStop(1, 'rgba(255, 110, 165, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(palm.x, palm.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    // Bones: dark under-stroke, luminous over-stroke.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(5, 2, 10, 0.55)';
    ctx.lineWidth = 3.8 * dpr;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255, 196, 222, 0.72)';
    ctx.lineWidth = 1.15 * dpr;
    ctx.shadowColor = 'rgba(255, 112, 169, 0.55)';
    ctx.shadowBlur = 7 * dpr;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Knuckles.
    ctx.fillStyle = 'rgba(255, 225, 237, 0.9)';
    for (const id of [5, 9, 13, 17]) {
      ctx.beginPath();
      ctx.arc(points[id].x, points[id].y, 1.7 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fingertips with breathing halo.
    const tips = [4, 8, 12, 16, 20];
    for (const id of tips) {
      const p = points[id];
      const pulse = 2.4 + Math.sin(t * 2.1 + id) * 0.8;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 239, 247, 0.94)';
      ctx.arc(p.x, p.y, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 148, 190, 0.55)';
      ctx.lineWidth = 1 * dpr;
      ctx.arc(p.x, p.y, (6 + pulse) * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Index tip: a brighter satellite ring, since it steers the aura.
    const index = points[8];
    const ringRadius = (10 + Math.sin(t * 1.8) * 2.5) * dpr;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 216, 234, 0.42)';
    ctx.lineWidth = 0.9 * dpr;
    ctx.arc(index.x, index.y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Handedness tick, small and unobtrusive.
    if (this.handedness) {
      ctx.font = `${6.5 * dpr}px "SFMono-Regular", Consolas, monospace`;
      ctx.fillStyle = 'rgba(255, 207, 226, 0.5)';
      ctx.fillText(
        this.handedness === 'Left' ? 'L' : 'R',
        points[0].x + 7 * dpr,
        points[0].y + 3 * dpr
      );
    }

    ctx.restore();
  }
}
