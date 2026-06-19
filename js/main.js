/* ============================================================
   DATREON — main.js
   Three.js ambient scenes + Lenis smooth scroll + GSAP system
   ============================================================ */

import * as THREE from 'three';

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin, SplitText);

/* Mono concept: names kept from the navy build — "blue" is ink, "cyan" is light gray */
const COLORS = {
  navy: 0x0B0B0C,
  blue: 0x1A1A1A,
  cyan: 0xD6D6D6,
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(pointer: fine)').matches;

/* Theme: additive glow blending reads as invisible on white, so the light
   theme switches to normal blending with deeper blues. */
const isLight = document.body.classList.contains('theme-light');
const THEME = {
  blend: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
  fog: isLight ? 0xFBFBFA : 0x070708,
  node: isLight ? 0x161616 : COLORS.cyan,
  dust: isLight ? 0x4A4A4A : 0x9A9A9A,
  line: isLight ? 0x161616 : 0xD6D6D6,
  lineOpacity: isLight ? 0.22 : 0.2,
  icoOpacity: isLight ? 0.16 : 0.14,
};

/* ============================================================
   LENIS — weighted, inertial smooth scrolling
   ============================================================ */

let lenis = null;
if (!reducedMotion && typeof Lenis !== 'undefined') {
  lenis = new Lenis({ duration: 1.15, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

/* ============================================================
   HERO SCENE — real-time fluid simulation (Lusion-style ink trail)
   Stable-fluids (Navier-Stokes) on the GPU: the cursor stirs monochrome
   ink that swirls via vorticity + pressure solve and slowly dissipates.
   Self-contained raw WebGL2 on #hero-canvas (no Three.js here).
   ============================================================ */

function initHeroScene() {
  const canvas = document.getElementById('hero-canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false,
  });
  if (!gl) return; // no WebGL2 — leave the hero clean

  gl.getExtension('EXT_color_buffer_float'); // render to 16F targets

  // Ink color: dark on the light concept, light if ever used on a dark theme.
  const INK = isLight ? [0.09, 0.09, 0.10] : [0.86, 0.86, 0.90];
  // Watery tint: cool glassy blue-gray for the liquid's refractive edges.
  const WATER = isLight ? [0.50, 0.64, 0.74] : [0.45, 0.70, 0.85];

  const config = {
    SIM_RES: 128,
    DYE_RES: 1024,
    DENSITY_DISS: 2.8,    // higher = fades faster (minimal: quick fade)
    VELOCITY_DISS: 1.4,   // motion settles fast
    PRESSURE: 0.8,
    PRESSURE_ITER: 18,
    CURL: 6,              // vorticity (minimal: barely any swirl)
    SPLAT_RADIUS: 0.13,   // thin, delicate strokes
    SPLAT_FORCE: 3000,    // soft push
    INK_AMOUNT: 0.09,     // faint
    OPACITY: 0.55,        // subtle overall
  };

  /* ---------- GL helpers ---------- */
  const baseVertex = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('shader', gl.getShaderInfoLog(s));
    return s;
  }
  function makeProgram(fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, baseVertex));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.warn('link', gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { p, uniforms, bind() { gl.useProgram(p); } };
  }

  const clearProg = makeProgram(`
    precision mediump float; varying vec2 vUv; uniform sampler2D uTexture; uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`);

  const splatProg = makeProgram(`
    precision highp float; varying vec2 vUv;
    uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;
    void main () {
      vec2 p = vUv - point.xy; p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
    }`);

  const advectionProg = makeProgram(`
    precision highp float; varying vec2 vUv;
    uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 texelSize; uniform float dt; uniform float dissipation;
    void main () {
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      gl_FragColor = texture2D(uSource, coord) / (1.0 + dissipation * dt);
    }`);

  const divergenceProg = makeProgram(`
    precision mediump float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x;
      float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y;
      float B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x;
      if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y;
      if (vB.y < 0.0) B = -C.y;
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`);

  const curlProg = makeProgram(`
    precision mediump float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y;
      float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x;
      float B = texture2D(uVelocity, vB).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`);

  const vorticityProg = makeProgram(`
    precision highp float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x;
      float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x;
      float B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 vel = texture2D(uVelocity, vUv).xy + force * dt;
      gl_FragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
    }`);

  const pressureProg = makeProgram(`
    precision mediump float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uPressure; uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      float divergence = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
    }`);

  const gradientProg = makeProgram(`
    precision mediump float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uPressure; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      vec2 velocity = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`);

  // Watery look: treat the dye field as a liquid surface. A fake normal from
  // the density gradient gives glassy refraction edges + specular glints,
  // rather than flat ink fill.
  const displayProg = makeProgram(`
    precision highp float;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uTexture;
    uniform vec3 uTint;
    uniform float uOpacity;
    void main () {
      float c = clamp(texture2D(uTexture, vUv).x, 0.0, 1.0);
      float l = texture2D(uTexture, vL).x;
      float r = texture2D(uTexture, vR).x;
      float t = texture2D(uTexture, vT).x;
      float b = texture2D(uTexture, vB).x;
      // fake surface normal from the gradient (heavily scaled so smooth dye still bends light)
      vec3 n = normalize(vec3((l - r) * 90.0, (b - t) * 90.0, 1.0));
      vec3 L = normalize(vec3(-0.5, 0.6, 0.6));
      float spec = pow(max(dot(n, L), 0.0), 20.0);   // bright glint
      float edge = pow(1.0 - n.z, 1.2);              // curved/meniscus rim
      float dens = smoothstep(0.0, 0.5, c);
      // translucent cool water body + white glints + slightly deeper rim
      vec3 col = uTint;
      col = mix(col, uTint * 0.78, edge * 0.6);      // refractive rim a touch deeper
      col = mix(col, vec3(1.0), spec * 0.9);         // specular sparkle
      float a = (dens * 0.55 + edge * 0.35 + spec * 0.5) * uOpacity;
      gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
    }`);

  /* ---------- Fullscreen quad ---------- */
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);
  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  /* ---------- Framebuffers ---------- */
  function createFBO(w, h, internal, format, type, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture, fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; },
    };
  }
  function createDoubleFBO(w, h, internal, format, type, filter) {
    let fbo1 = createFBO(w, h, internal, format, type, filter);
    let fbo2 = createFBO(w, h, internal, format, type, filter);
    return {
      width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      get read() { return fbo1; }, set read(v) { fbo1 = v; },
      get write() { return fbo2; }, set write(v) { fbo2 = v; },
      swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; },
    };
  }

  function getResolution(res) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const min = Math.round(res), max = Math.round(res * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
  }

  let velocity, dye, divergence, curl, pressure;
  function initFBOs() {
    const sim = getResolution(config.SIM_RES);
    const dyeRes = getResolution(config.DYE_RES);
    const T = gl.HALF_FLOAT;
    dye = createDoubleFBO(dyeRes.width, dyeRes.height, gl.RGBA16F, gl.RGBA, T, gl.LINEAR);
    velocity = createDoubleFBO(sim.width, sim.height, gl.RG16F, gl.RG, T, gl.LINEAR);
    divergence = createFBO(sim.width, sim.height, gl.R16F, gl.RED, T, gl.NEAREST);
    curl = createFBO(sim.width, sim.height, gl.R16F, gl.RED, T, gl.NEAREST);
    pressure = createDoubleFBO(sim.width, sim.height, gl.R16F, gl.RED, T, gl.NEAREST);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      initFBOs();
    }
  }
  resize();

  /* ---------- Pointer ---------- */
  const pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, moved: false };
  let lastX = 0.5, lastY = 0.5, hasLast = false;
  if (finePointer) {
    window.addEventListener('pointermove', (e) => {
      const x = e.clientX / window.innerWidth;
      const y = 1 - e.clientY / window.innerHeight;
      if (!hasLast) { lastX = x; lastY = y; hasLast = true; }
      pointer.dx = x - lastX;
      pointer.dy = y - lastY;
      pointer.x = x; pointer.y = y;
      lastX = x; lastY = y;
      if (pointer.dx !== 0 || pointer.dy !== 0) pointer.moved = true;
    }, { passive: true });
  }

  function splatRadius() {
    let r = config.SPLAT_RADIUS / 100;
    const ar = canvas.width / canvas.height;
    if (ar > 1) r *= ar;
    return r;
  }
  function splat(x, y, dx, dy) {
    splatProg.bind();
    gl.uniform1i(splatProg.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProg.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProg.uniforms.point, x, y);
    gl.uniform3f(splatProg.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProg.uniforms.radius, splatRadius());
    blit(velocity.write); velocity.swap();

    gl.uniform1i(splatProg.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProg.uniforms.color, config.INK_AMOUNT, config.INK_AMOUNT, config.INK_AMOUNT);
    blit(dye.write); dye.swap();
  }

  function step(dt) {
    gl.disable(gl.BLEND);

    curlProg.bind();
    gl.uniform2f(curlProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProg.bind();
    gl.uniform2f(vorticityProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProg.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProg.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProg.uniforms.dt, dt);
    blit(velocity.write); velocity.swap();

    divergenceProg.bind();
    gl.uniform2f(divergenceProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProg.bind();
    gl.uniform1i(clearProg.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProg.uniforms.value, config.PRESSURE);
    blit(pressure.write); pressure.swap();

    pressureProg.bind();
    gl.uniform2f(pressureProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProg.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITER; i++) {
      gl.uniform1i(pressureProg.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    gradientProg.bind();
    gl.uniform2f(gradientProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientProg.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientProg.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    advectionProg.bind();
    gl.uniform2f(advectionProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProg.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(advectionProg.uniforms.dt, dt);
    gl.uniform1f(advectionProg.uniforms.dissipation, config.VELOCITY_DISS);
    blit(velocity.write); velocity.swap();

    gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProg.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProg.uniforms.dissipation, config.DENSITY_DISS);
    blit(dye.write); dye.swap();
  }

  function render(fade) {
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    displayProg.bind();
    gl.uniform2f(displayProg.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(displayProg.uniforms.uTexture, dye.read.attach(0));
    gl.uniform3f(displayProg.uniforms.uTint, WATER[0], WATER[1], WATER[2]);
    gl.uniform1f(displayProg.uniforms.uOpacity, config.OPACITY * fade);
    blit(null);
  }

  /* ---------- Scroll dissolve ---------- */
  const dissolve = { t: 0 };
  ScrollTrigger.create({
    trigger: '#hero', start: 'top top', end: 'bottom top', scrub: 0.6,
    onUpdate: (self) => { dissolve.t = self.progress; },
  });

  window.addEventListener('resize', resize);

  if (reducedMotion) {
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }

  /* ---------- Loop ---------- */
  let lastTime = performance.now();
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    dt = Math.min(dt, 0.0166);

    const fade = Math.max(0, 1 - dissolve.t * 1.25);
    canvas.style.opacity = fade;
    if (fade <= 0.001) return;

    if (pointer.moved) {
      splat(pointer.x, pointer.y, pointer.dx * config.SPLAT_FORCE, pointer.dy * config.SPLAT_FORCE);
      pointer.moved = false;
    }
    step(dt);
    render(fade);
  }
  frame();
}

/* ============================================================
   WORK SCENE — sparse drifting particles behind the case study
   (the work section is dark navy in both themes)
   ============================================================ */

function initWorkScene() {
  const canvas = document.getElementById('work-canvas');
  const section = document.getElementById('work');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 60);
  camera.position.z = 14;

  const COUNT = 160;
  const positions = new Float32Array(COUNT * 3);
  const speeds = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 40;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 18;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 12;
    speeds[i] = 0.002 + Math.random() * 0.006;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xFFFFFF,
    size: 0.07,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  scene.add(new THREE.Points(geo, mat));

  function resize() {
    const w = section.offsetWidth;
    const h = section.offsetHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  let visible = false;
  ScrollTrigger.create({
    trigger: section,
    start: 'top bottom',
    end: 'bottom top',
    onToggle: (self) => { visible = self.isActive; },
  });

  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    if (!visible) return;
    const t = clock.getElapsedTime();
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3 + 1] += speeds[i];
      if (positions[i * 3 + 1] > 9) positions[i * 3 + 1] = -9;
    }
    geo.attributes.position.needsUpdate = true;
    mat.opacity = 0.35 + Math.sin(t * 0.7) * 0.1;
    renderer.render(scene, camera);
  }
  tick();
}

/* ============================================================
   ABOUT SCENE — rotating wireframe torus knot
   ============================================================ */

function initAboutScene() {
  const canvas = document.getElementById('about-canvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
  camera.position.z = 9.5;

  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(2, 0.55, 140, 18),
    new THREE.MeshBasicMaterial({ color: isLight ? 0x222222 : 0xD6D6D6, wireframe: true, transparent: true, opacity: 0.3 })
  );
  scene.add(knot);

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.9, 0),
    new THREE.MeshBasicMaterial({ color: isLight ? 0x111111 : 0xFFFFFF, wireframe: true, transparent: true, opacity: 0.5 })
  );
  scene.add(core);

  function resize() {
    const w = wrap.offsetWidth;
    const h = wrap.offsetHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  let visible = false;
  ScrollTrigger.create({
    trigger: wrap,
    start: 'top bottom',
    end: 'bottom top',
    onToggle: (self) => { visible = self.isActive; },
  });

  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    if (!visible) return;
    const t = clock.getElapsedTime();
    if (!reducedMotion) {
      knot.rotation.x = t * 0.18;
      knot.rotation.y = t * 0.24;
      core.rotation.x = -t * 0.4;
      core.rotation.y = t * 0.3;
    }
    renderer.render(scene, camera);
  }
  tick();
}

/* ============================================================
   GSAP — preloader, entrance, masked reveals, magnetic buttons
   ============================================================ */

function initAnimations() {
  /* ---- Nav solid-on-scroll ---- */
  const nav = document.getElementById('nav');
  const updateNav = () => nav.classList.toggle('is-solid', window.scrollY > 80);
  window.addEventListener('scroll', updateNav, { passive: true });
  updateNav();

  /* ---- Menu overlay ---- */
  const menu = document.getElementById('menu');
  const menuOpen = document.getElementById('menu-open');
  const menuClose = document.getElementById('menu-close');
  const menuScrim = document.getElementById('menu-scrim');
  const menuPanel = menu.querySelector('.menu__panel');
  const navClockEl = nav.querySelector('.nav__clock');
  const menuClockEl = menu.querySelector('.menu__head .nav__clock');
  const menuLinks = menu.querySelectorAll('.menu__link');
  // Links + the "Start a Project" CTA cascade in together on open
  const menuRevealEls = [...menuLinks, menu.querySelector('.menu__cta')].filter(Boolean);

  const setMenu = (open) => {
    if (open) {
      // Capture nav clock's current screen position
      const navRect = navClockEl.getBoundingClientRect();

      // Peek at menu clock's final resting position by briefly forcing panel open (no paint)
      const sT = menuPanel.style.transition, sX = menuPanel.style.transform, sO = menuPanel.style.opacity;
      menuPanel.style.transition = 'none';
      menuPanel.style.transform = 'none';
      menuPanel.style.opacity = '1';
      menu.style.visibility = 'visible';
      void menuPanel.offsetHeight; // flush
      const menuClockRect = menuClockEl.getBoundingClientRect();
      menuPanel.style.transition = sT;
      menuPanel.style.transform = sX;
      menuPanel.style.opacity = sO;
      menu.style.visibility = '';
      void menuPanel.offsetHeight; // settle closed state before transition plays

      const dx = navRect.left + navRect.width / 2 - (menuClockRect.left + menuClockRect.width / 2);
      const dy = navRect.top + navRect.height / 2 - (menuClockRect.top + menuClockRect.height / 2);

      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden', 'false');
      menuOpen.setAttribute('aria-expanded', 'true');
      if (lenis) lenis.stop();
      else document.body.style.overflow = 'hidden';

      // Hide nav clock; fly menu clock in from nav clock's position
      gsap.set(navClockEl, { opacity: 0 });
      gsap.killTweensOf(menuClockEl);
      // Only FLIP on desktop where nav clock is visible
      const navClockVisible = navClockEl.clientWidth > 0;
      gsap.fromTo(menuClockEl,
        navClockVisible ? { x: dx, y: dy, opacity: 0 } : { y: -6, opacity: 0 },
        { x: 0, y: 0, opacity: 1, duration: 0.65, ease: 'power3.out', delay: 0.05,
          onComplete: () => gsap.set(menuClockEl, { clearProps: 'x,y,opacity' }) }
      );

      // Stagger nav links + CTA in
      gsap.killTweensOf(menuRevealEls);
      gsap.fromTo(menuRevealEls,
        { y: 26, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.55, ease: 'power3.out', stagger: 0.07, delay: 0.18,
          onComplete: () => gsap.set(menuRevealEls, { clearProps: 'transform,opacity' }) }
      );

    } else {
      gsap.killTweensOf([menuClockEl, ...menuRevealEls]);
      gsap.set(menuClockEl, { clearProps: 'x,y,opacity' });
      gsap.set(menuRevealEls, { clearProps: 'transform,opacity' });

      menu.classList.remove('is-open');
      menu.setAttribute('aria-hidden', 'true');
      menuOpen.setAttribute('aria-expanded', 'false');
      if (lenis) lenis.start();
      else document.body.style.overflow = '';

      // Restore nav clock after panel starts closing
      gsap.to(navClockEl, { opacity: 1, duration: 0.35, ease: 'power3.out', delay: 0.2 });
    }
  };
  menuOpen.addEventListener('click', () => setMenu(true));
  menuClose.addEventListener('click', () => setMenu(false));
  menuScrim.addEventListener('click', () => setMenu(false));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  /* ---- Live local clock (Eastern Time) — digits black, AM/PM gray ---- */
  const clockEls = [document.getElementById('nav-time'), document.getElementById('menu-time')].filter(Boolean);
  const updateClock = () => {
    const t = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York',
    }).format(new Date());
    const [digits, ampm = ''] = t.split(' ');
    clockEls.forEach((el) => {
      const d = el.querySelector('.time-digits');
      const a = el.querySelector('.time-ampm');
      if (d && a) { d.textContent = digits; a.textContent = ' ' + ampm; }
      else { el.textContent = t; }
    });
  };
  updateClock();
  setInterval(updateClock, 15000);

  /* ---- Smooth anchor scrolling ---- */
  document.querySelectorAll('a[data-scroll]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const target = link.getAttribute('href');
      if (!target.startsWith('#')) return;
      e.preventDefault();
      setMenu(false);
      const dest = target === '#top' ? 0 : target;
      if (lenis) {
        lenis.scrollTo(dest, { duration: 1.4, easing: (t) => 1 - Math.pow(1 - t, 4) });
      } else {
        gsap.to(window, { duration: 1, ease: 'power3.inOut', scrollTo: { y: dest, offsetY: 0 } });
      }
    });
  });

  /* ---- Hero entrance: masked line reveal ---- */
  const heroSplit = new SplitText('#hero-title', { type: 'lines', mask: 'lines' });
  gsap.set('#hero-title', { opacity: 1 });

  const intro = gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } });
  intro
    .to('#nav', { opacity: 1, y: 0, duration: 0.8, startAt: { y: -24 } }, 0.1)
    .to('.hero__eyebrow', { opacity: 1, y: 0, duration: 0.7, startAt: { y: 16 } }, 0.25)
    .from(heroSplit.lines, {
      yPercent: 115,
      duration: 1.15,
      stagger: 0.1,
      ease: 'power4.out',
      // the mask wrappers clip descenders (g, y) at this line-height —
      // restore the original markup once the reveal is done
      onComplete: () => heroSplit.revert(),
    }, 0.35)
    .to('.hero__sub', { opacity: 1, y: 0, duration: 0.8, startAt: { y: 22 } }, '-=0.7')
    .to('.hero__cta', { opacity: 1, y: 0, duration: 0.8, startAt: { y: 22 } }, '-=0.6')
    .to('#hero-scroll', { opacity: 1, duration: 0.7 }, '-=0.4');

  /* ---- Preloader exit → hero intro ---- */
  const pre = document.getElementById('preloader');
  if (pre && !reducedMotion) {
    if (lenis) lenis.stop();
    const exit = gsap.timeline({ delay: 0.55 });
    exit
      .to('.preloader__brand', { opacity: 0, y: -16, duration: 0.4, ease: 'power2.in' })
      .to(pre, {
        yPercent: -100,
        duration: 0.85,
        ease: 'power4.inOut',
        onComplete: () => {
          pre.remove();
          if (lenis) lenis.start();
        },
      }, '-=0.05')
      .add(() => intro.play(), '-=0.45');
  } else {
    if (pre) pre.remove();
    intro.play();
  }

  /* ---- Section titles: masked line reveals on scroll ---- */
  document.querySelectorAll('.section__title').forEach((el) => {
    const split = new SplitText(el, { type: 'lines', mask: 'lines' });
    gsap.from(split.lines, {
      yPercent: 115,
      duration: 1.05,
      stagger: 0.09,
      ease: 'power4.out',
      // revert so the mask wrappers stop clipping descenders at rest
      onComplete: () => split.revert(),
      scrollTrigger: { trigger: el, start: 'top 88%' },
    });
  });

  /* ---- Magnetic buttons ---- */
  if (finePointer && !reducedMotion) {
    document.querySelectorAll('.btn').forEach((el) => {
      const xTo = gsap.quickTo(el, 'x', { duration: 0.45, ease: 'power3' });
      const yTo = gsap.quickTo(el, 'y', { duration: 0.45, ease: 'power3' });
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        xTo((e.clientX - r.left - r.width / 2) * 0.22);
        yTo((e.clientY - r.top - r.height / 2) * 0.34);
      });
      el.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
    });
  }

  /* ---- Generic section reveals ---- */
  gsap.utils.toArray('[data-reveal]').forEach((el) => {
    gsap.from(el, {
      opacity: 0,
      y: 32,
      duration: 1,
      ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 88%' },
    });
  });

  /* ---- Service rows: staggered rise ---- */
  gsap.from('.srow', {
    opacity: 0,
    y: 44,
    duration: 0.9,
    ease: 'power3.out',
    stagger: 0.08,
    scrollTrigger: { trigger: '.services__list', start: 'top 85%' },
  });

  /* ---- Serve columns: stagger ---- */
  const serveCols = document.querySelectorAll('.serve__grid [data-card]');
  if (serveCols.length) {
    gsap.from(serveCols, {
      opacity: 0,
      y: 40,
      duration: 0.9,
      ease: 'power3.out',
      stagger: 0.12,
      scrollTrigger: { trigger: '.serve__grid', start: 'top 84%' },
    });
  }

  /* ---- Case media: clip-path wipe + scale settle ---- */
  gsap.utils.toArray('[data-media]').forEach((el) => {
    const inner = el.querySelector('.media__inner');
    const tl = gsap.timeline({
      scrollTrigger: { trigger: el, start: 'top 82%' },
    });
    tl.from(el, { clipPath: 'inset(0% 0% 100% 0%)', duration: 1.2, ease: 'power4.inOut' })
      .from(inner, { scale: 1.18, duration: 1.8, ease: 'power3.out' }, 0);
  });

  /* ---- Stats: fade in + count up ---- */
  const stats = document.querySelectorAll('[data-stat]');
  gsap.from(stats, {
    opacity: 0,
    y: 28,
    duration: 0.8,
    ease: 'power3.out',
    stagger: 0.12,
    scrollTrigger: { trigger: '#stats', start: 'top 85%' },
  });

  document.querySelectorAll('[data-count]').forEach((el) => {
    const target = parseFloat(el.dataset.count);
    const obj = { val: 0 };
    gsap.to(obj, {
      val: target,
      duration: 1.6,
      ease: 'power2.out',
      scrollTrigger: { trigger: '#stats', start: 'top 85%' },
      onUpdate: () => { el.textContent = Math.round(obj.val); },
    });
  });

  /* ---- Process: horizontal scroll on desktop, list on mobile ---- */
  const mm = gsap.matchMedia();
  mm.add('(min-width: 769px)', () => {
    const track = document.getElementById('process-track');
    const getDistance = () => track.scrollWidth - window.innerWidth + 48;

    const scrollTween = gsap.to(track, {
      x: () => -getDistance(),
      ease: 'none',
      scrollTrigger: {
        trigger: '#process',
        start: 'top top',
        end: () => `+=${getDistance()}`,
        pin: '.process__pin',
        scrub: 0.8,
        invalidateOnRefresh: true,
        anticipatePin: 1,
      },
    });

    gsap.from('.step', {
      opacity: 0,
      y: 40,
      duration: 0.6,
      ease: 'power3.out',
      stagger: 0.12,
      scrollTrigger: { trigger: '#process', start: 'top 70%' },
    });

    return () => scrollTween.scrollTrigger && scrollTween.scrollTrigger.kill();
  });

  mm.add('(max-width: 768px)', () => {
    gsap.utils.toArray('.step').forEach((step) => {
      gsap.from(step, {
        opacity: 0,
        y: 36,
        duration: 0.7,
        ease: 'power3.out',
        scrollTrigger: { trigger: step, start: 'top 88%' },
      });
    });
  });
}

/* ============================================================
   Boot
   ============================================================ */

window.addEventListener('load', () => ScrollTrigger.refresh());

// The hero fluid sim is pointer-driven and adds nothing on touch devices —
// skip it on coarse-pointer (mobile) so its fixed WebGL layer can't cause
// scroll-compositing flashes on iOS/Android.
if (finePointer) initHeroScene();
initWorkScene();
initAboutScene();

// SplitText must measure with the final font, not the fallback
document.fonts.ready.then(() => {
  initAnimations();
  ScrollTrigger.refresh();
});
