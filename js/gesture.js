/**
 * gesture.js
 * ------------------------------------------------------------
 * Pure hand-shape analysis for MediaPipe's 21-point hand model.
 * No DOM / WebGL / MediaPipe imports live here, so this module can
 * be unit-tested in Node and reasoned about in isolation.
 *
 * Landmark map:
 *   0 wrist
 *   1-4   thumb  (cmc, mcp, ip, tip)
 *   5-8   index  (mcp, pip, dip, tip)
 *   9-12  middle
 *   13-16 ring
 *   17-20 pinky
 */

export const FINGERS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

/** Bone pairs used by the camera preview overlay. */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const clamp = (value, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export const lerp = (a, b, t) => a + (b - a) * t;

export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/**
 * Frame-rate independent exponential damping.
 * lambda = 1 / smoothing time (seconds).
 */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * Math.max(0, dt)));

/** Aspect-corrected distance between two normalized landmarks. */
export function distance(a, b, aspect = 1) {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  // z is roughly in the same normalized units as x; de-emphasise it
  return Math.hypot(dx, dy, dz * 0.55);
}

function pathLength(points, indices, aspect) {
  let total = 0;
  for (let i = 0; i < indices.length - 1; i += 1) {
    total += distance(points[indices[i]], points[indices[i + 1]], aspect);
  }
  return total;
}

/**
 * How extended a single finger is, in 0..1.
 * Blends "tip is far from the wrist" with "the finger bones are straight".
 */
function fingerExtension(points, indices, palmSize, aspect) {
  const [mcp, pip, dip, tip] = indices;
  const wrist = points[0];

  const reach = distance(points[tip], wrist, aspect) / palmSize;
  const chain = pathLength(points, indices, aspect);
  const straight = distance(points[tip], points[mcp], aspect) / Math.max(chain, 1e-5);

  const reachScore = smoothstep(1.28, 2.05, reach);
  const straightScore = smoothstep(0.6, 0.92, straight);
  return clamp(reachScore * 0.58 + straightScore * 0.42);
}

function thumbExtension(points, palmSize, aspect) {
  const tip = points[4];
  const indexTip = points[8];
  const pinkyMcp = points[17];
  const thumbMcp = points[2];

  // Thumb splay: how far the thumb tip travels away from the index finger
  // and toward the pinky side of the palm.
  const splay = distance(tip, indexTip, aspect) / palmSize;
  const span = distance(tip, pinkyMcp, aspect) / palmSize;
  const awayFromPalm = distance(tip, thumbMcp, aspect) / palmSize;

  return clamp(
    smoothstep(0.32, 1.18, splay) * 0.48 +
    smoothstep(1.05, 2.05, span) * 0.32 +
    smoothstep(0.52, 0.95, awayFromPalm) * 0.2
  );
}

/** Palm center, weighted toward the stable metacarpal knuckles. */
export function palmCenter(points) {
  const ids = [0, 5, 9, 13, 17];
  const weights = [0.18, 0.22, 0.24, 0.2, 0.16];
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  ids.forEach((id, i) => {
    x += points[id].x * weights[i];
    y += points[id].y * weights[i];
    z += (points[id].z || 0) * weights[i];
    w += weights[i];
  });
  return { x: x / w, y: y / w, z: z / w };
}

/**
 * Analyse a single hand.
 *
 * @param {Array<{x:number,y:number,z:number}>} landmarks MediaPipe normalized points
 * @param {number} aspect videoWidth / videoHeight (defaults to 4/3)
 * @returns {{
 *   present: true,
 *   openness: number,
 *   pinch: number,
 *   fingers: Record<string, number>,
 *   spread: number,
 *   palmSize: number,
 *   palm: {x:number,y:number,z:number},
 *   indexTip: {x:number,y:number,z:number},
 *   middleTip: {x:number,y:number,z:number},
 *   thumbTip: {x:number,y:number,z:number},
 *   wrist: {x:number,y:number,z:number}
 * } | null}
 */
export function analyzeHand(landmarks, aspect = 4 / 3) {
  if (!landmarks || landmarks.length < 21) return null;

  // Reject degenerate input (all points collapsed, NaNs, etc).
  const finite = landmarks.every(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y)
  );
  if (!finite) return null;

  const palmSize = distance(landmarks[0], landmarks[9], aspect);
  if (!Number.isFinite(palmSize) || palmSize < 1e-5) return null;

  const fingers = {
    index: fingerExtension(landmarks, FINGERS.index, palmSize, aspect),
    middle: fingerExtension(landmarks, FINGERS.middle, palmSize, aspect),
    ring: fingerExtension(landmarks, FINGERS.ring, palmSize, aspect),
    pinky: fingerExtension(landmarks, FINGERS.pinky, palmSize, aspect),
    thumb: thumbExtension(landmarks, palmSize, aspect),
  };

  const spreadRaw =
    distance(landmarks[8], landmarks[20], aspect) / palmSize;
  const spread = smoothstep(0.92, 1.95, spreadRaw);

  // Index and middle dominate the read: they are the most reliably
  // tracked and carry most of the silhouette change.
  const fingerAvg =
    fingers.index * 1.06 +
    fingers.middle * 1.12 +
    fingers.ring * 0.98 +
    fingers.pinky * 0.84;
  const openness = clamp(
    (fingerAvg / 4) * 0.74 + spread * 0.18 + fingers.thumb * 0.08
  );

  const pinchRaw = distance(landmarks[4], landmarks[8], aspect) / palmSize;
  const pinch = clamp(1 - smoothstep(0.18, 0.62, pinchRaw));

  return {
    present: true,
    openness,
    pinch,
    fingers,
    spread,
    palmSize,
    palm: palmCenter(landmarks),
    wrist: { ...landmarks[0] },
    indexTip: { ...landmarks[8] },
    middleTip: { ...landmarks[12] },
    thumbTip: { ...landmarks[4] },
    landmarks,
  };
}

/**
 * Temporal smoothing + hysteresis for the live bloom value.
 *
 * The visual openness follows the hand continuously, but the textual
 * state only flips after crossing generous thresholds. That keeps the
 * readout from strobing while fingers are mid-transition.
 */
export class GestureSmoother {
  constructor(options = {}) {
    this.openThreshold = options.openThreshold ?? 0.62;
    this.closeThreshold = options.closeThreshold ?? 0.34;
    this.attack = options.attack ?? 10; // 1/s, opening response
    this.release = options.release ?? 5.5; // 1/s, closing response

    this.value = 0;
    this.raw = 0;
    this.state = 'closed';
    this.present = false;
    this.pinch = 0;
    this.confidence = 0;
    this.lastSeen = -Infinity;
    this._last = null;
  }

  /**
   * @param {ReturnType<typeof analyzeHand>} analysis
   * @param {number} dt seconds
   * @param {number} now seconds
   */
  update(analysis, dt, now = 0) {
    this._last = analysis;
    const step = Math.min(0.05, Math.max(0.001, dt || 0.016));

    if (analysis) {
      this.present = true;
      this.lastSeen = now;
      this.raw = analysis.openness;
      this.pinch = damp(this.pinch, analysis.pinch, 9, step);

      const target = analysis.openness;
      // Opening reacts a touch faster than closing: petals should answer
      // the hand immediately, then relax like a real flower.
      const rate = target > this.value ? this.attack : this.release;
      this.value = damp(this.value, target, rate, step);
      this.confidence = damp(this.confidence, 1, 6, step);
    } else {
      this.present = false;
      this.confidence = damp(this.confidence, 0, 3, step);
      // No hand: settle into a quiet, almost-closed breath.
      this.value = damp(this.value, 0.04, 1.4, step);
      this.raw = this.value;
      this.pinch = damp(this.pinch, 0, 4, step);
    }

    this.value = clamp(this.value);

    if (this.state === 'closed' && this.value > this.openThreshold) {
      this.state = 'open';
    } else if (this.state === 'open' && this.value < this.closeThreshold) {
      this.state = 'closed';
    }

    return this;
  }

  /** Latest analysis (or null). */
  get analysis() {
    return this._last;
  }

  reset() {
    this.value = 0;
    this.raw = 0;
    this.state = 'closed';
    this.present = false;
    this.pinch = 0;
    this.confidence = 0;
    this.lastSeen = -Infinity;
    this._last = null;
  }
}
