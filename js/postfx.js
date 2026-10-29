/**
 * postfx.js
 * ------------------------------------------------------------
 * A compact, dependency-free bloom / grade pipeline:
 *
 *   scene -> HDR target
 *         -> bright pass (half res)
 *         -> 2x separable gaussian (half res)
 *         -> ACES tonemap + grade + grain + vignette -> screen
 *
 * Written by hand instead of pulling in EffectComposer + UnrealBloomPass,
 * which keeps the vendor tree small and lets the palette be tuned exactly
 * to this piece.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BRIGHT_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uKnee;

  varying vec2 vUv;

  void main() {
    vec3 color = texture2D(tDiffuse, vUv).rgb;
    float luma = max(color.r, max(color.g, color.b));
    float contribution = smoothstep(uThreshold, uThreshold + uKnee, luma);
    gl_FragColor = vec4(color * contribution, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tDiffuse;
  uniform vec2 uDirection;
  uniform vec2 uTexel;

  varying vec2 vUv;

  const float W0 = 0.2270270270;
  const float W1 = 0.1945945946;
  const float W2 = 0.1216216216;
  const float W3 = 0.0540540541;
  const float W4 = 0.0162162162;

  void main() {
    vec2 stepUv = uDirection * uTexel;

    vec3 color = texture2D(tDiffuse, vUv).rgb * W0;
    color += texture2D(tDiffuse, vUv + stepUv * 1.0).rgb * W1;
    color += texture2D(tDiffuse, vUv - stepUv * 1.0).rgb * W1;
    color += texture2D(tDiffuse, vUv + stepUv * 2.0).rgb * W2;
    color += texture2D(tDiffuse, vUv - stepUv * 2.0).rgb * W2;
    color += texture2D(tDiffuse, vUv + stepUv * 3.0).rgb * W3;
    color += texture2D(tDiffuse, vUv - stepUv * 3.0).rgb * W3;
    color += texture2D(tDiffuse, vUv + stepUv * 4.0).rgb * W4;
    color += texture2D(tDiffuse, vUv - stepUv * 4.0).rgb * W4;

    gl_FragColor = vec4(color, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uBloomStrength;
  uniform float uExposure;

  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  vec3 acesFilmic(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  vec3 linearToSRGB(vec3 c) {
    return mix(
      1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
      c * 12.92,
      step(c, vec3(0.0031308))
    );
  }

  void main() {
    vec2 uv = vUv;
    vec2 centered = uv - 0.5;
    float radius2 = dot(centered, centered);

    // A whisper of lens dispersion, strongest at the edges.
    float ca = radius2 * 0.008;
    vec3 scene;
    scene.r = texture2D(tScene, uv + centered * ca).r;
    scene.g = texture2D(tScene, uv).g;
    scene.b = texture2D(tScene, uv - centered * ca).b;

    vec3 bloom = texture2D(tBloom, uv).rgb;
    vec3 color = scene + bloom * uBloomStrength;

    // Lift the shadows onto a plum rather than pure black.
    color += vec3(0.008, 0.0025, 0.014);
    color *= uExposure;
    color = acesFilmic(color);

    // Warm the highlights, cool the shadows a touch.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    vec3 warm = color * vec3(1.045, 1.0, 0.965);
    vec3 cool = color * vec3(0.95, 0.975, 1.06);
    color = mix(cool, warm, smoothstep(0.22, 0.82, luma));

    // Gentle vignette.
    float vignette = 1.0 - 0.46 * smoothstep(0.34, 0.92, length(centered) * 1.32);
    color *= vignette;

    // Film grain + a hint of dither to keep gradients from banding.
    float grain = hash21(uv * uResolution + uTime * 57.0) - 0.5;
    color += grain * 0.018;

    gl_FragColor = vec4(linearToSRGB(max(color, 0.0)), 1.0);
  }
`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    this.width = 1;
    this.height = 1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const canFloat =
      renderer.capabilities.isWebGL2 &&
      (renderer.extensions.has('EXT_color_buffer_float') ||
        renderer.extensions.has('EXT_color_buffer_half_float'));
    this.bufferType = canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;

    const targetOptions = {
      type: this.bufferType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    };

    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions);
    this.brightTarget = new THREE.WebGLRenderTarget(1, 1, {
      ...targetOptions,
      depthBuffer: false,
    });
    this.blurTargetA = new THREE.WebGLRenderTarget(1, 1, {
      ...targetOptions,
      depthBuffer: false,
    });
    this.blurTargetB = new THREE.WebGLRenderTarget(1, 1, {
      ...targetOptions,
      depthBuffer: false,
    });

    this.brightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.sceneTarget.texture },
        uThreshold: { value: 0.38 },
        uKnee: { value: 0.32 },
      },
      vertexShader: VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.sceneTarget.texture },
        tBloom: { value: this.blurTargetB.texture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uBloomStrength: { value: 0.95 },
        uExposure: { value: 1.08 },
      },
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }

  /**
   * @param {number} width CSS pixels
   * @param {number} height CSS pixels
   * @param {number} dpr device pixel ratio
   */
  setSize(width, height, dpr = 1) {
    this.width = Math.max(1, Math.round(width * dpr));
    this.height = Math.max(1, Math.round(height * dpr));
    this.dpr = dpr;

    this.sceneTarget.setSize(this.width, this.height);

    const halfW = Math.max(1, Math.floor(this.width / 2));
    const halfH = Math.max(1, Math.floor(this.height / 2));
    this.brightTarget.setSize(halfW, halfH);
    this.blurTargetA.setSize(halfW, halfH);
    this.blurTargetB.setSize(halfW, halfH);

    this.blurMaterial.uniforms.uTexel.value.set(1 / halfW, 1 / halfH);
    this.compositeMaterial.uniforms.uResolution.value.set(this.width, this.height);
  }

  render(scene, camera, time = 0) {
    const renderer = this.renderer;

    if (!this.enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    // 1. Scene into the HDR buffer.
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // 2. Isolate the light.
    this.quad.material = this.brightMaterial;
    this.brightMaterial.uniforms.tDiffuse.value = this.sceneTarget.texture;
    renderer.setRenderTarget(this.brightTarget);
    renderer.render(this.scene, this.camera);

    // 3. Separable gaussian, two passes.
    this.quad.material = this.blurMaterial;
    let source = this.brightTarget;
    for (let i = 0; i < 2; i += 1) {
      this.blurMaterial.uniforms.tDiffuse.value = source.texture;
      this.blurMaterial.uniforms.uDirection.value.set(1, 0);
      renderer.setRenderTarget(this.blurTargetA);
      renderer.render(this.scene, this.camera);

      this.blurMaterial.uniforms.tDiffuse.value = this.blurTargetA.texture;
      this.blurMaterial.uniforms.uDirection.value.set(0, 1);
      renderer.setRenderTarget(this.blurTargetB);
      renderer.render(this.scene, this.camera);

      source = this.blurTargetB;
    }

    // 4. Grade and present.
    this.compositeMaterial.uniforms.tScene.value = this.sceneTarget.texture;
    this.compositeMaterial.uniforms.tBloom.value = this.blurTargetB.texture;
    this.compositeMaterial.uniforms.uTime.value = time;
    this.quad.material = this.compositeMaterial;

    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.brightTarget.dispose();
    this.blurTargetA.dispose();
    this.blurTargetB.dispose();
    this.brightMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.geometry.dispose();
  }
}
