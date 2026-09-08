// ============================================================
// PERFORMANCE PROBE — self-contained escalating stress test.
//
// Run from browser console:  await window.perfProbe()
//
// Builds everything it needs internally — no game state, no
// multiplayer connection, no prior permissions required (it will
// prompt for camera/mic and gracefully skip if denied).
//
// Escalating steps, each layering one more subsystem:
//   Step 1: GPU render + 2D readback
//   Step 2: + camera capture (getUserMedia video)
//   Step 3: + audio DSP (echoCancellation + noiseSuppression)
//   Step 4: + simulated partner video decode
//   Step 5: + full composite (PiP + HUD overlay)
//
// Output: per-step timing with deltas, GPU string, lowEnd boolean.
// ============================================================

const ITERATIONS = 30;
const WARMUP = 5;
export const LOW_END_FPS = 45; // game targets 60fps; below 45 means consistently over budget
export const LOW_END_MS = 1000 / LOW_END_FPS; // ~22ms — same threshold in ms form

export async function perfProbe() {
  console.log('%c[PERF-PROBE] Starting...', 'color:#0af;font-weight:bold');
  const W = window.innerWidth;
  const H = window.innerHeight;

  // ── GPU renderer string ──
  const gpuRenderer = getGpuString();
  console.log(`[PERF-PROBE] GPU: ${gpuRenderer}`);
  console.log(`[PERF-PROBE] Viewport: ${W}×${H}`);

  // ── Build a standalone WebGL scene ──
  const glCanvas = document.createElement('canvas');
  glCanvas.width = W;
  glCanvas.height = H;
  const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) {
    console.error('[PERF-PROBE] WebGL not available');
    return { error: 'WebGL not available' };
  }

  const { renderFrame, cleanup: cleanupGL } = buildGLScene(gl, W, H);

  // 2D compositing target (mirrors GameRecorder)
  const compCanvas = document.createElement('canvas');
  compCanvas.width = W;
  compCanvas.height = H;
  const compCtx = compCanvas.getContext('2d', { willReadFrequently: true });

  // gl.finish() + getImageData() inside _measure force the full GPU→CPU
  // pipeline to actually complete.  Without this, drawImage is deferred
  // and we measure nothing but JS call overhead.

  const results = [];
  const measure = (label, workFn) => _measure(results, label, workFn, gl, compCtx);

  // ── Step 1: GPU render + readback (baseline) ──
  measure('1-render+readback', () => {
    renderFrame();
    compCtx.drawImage(glCanvas, 0, 0, W, H);
  });

  // ── Step 2: + camera capture ──
  let cameraStream = null;
  let cameraVideo = null;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 240, height: 240 },
      audio: false
    });
    cameraVideo = _createVideo(cameraStream);
    await cameraVideo.play();
    await _delay(500);

    measure('2-+camera', () => {
      renderFrame();
      compCtx.drawImage(glCanvas, 0, 0, W, H);
      if (cameraVideo.readyState >= 2) {
        compCtx.drawImage(cameraVideo, 0, 0, 120, 120);
      }
    });
  } catch (e) {
    _skip(results, '2-+camera', e.message);
  }

  // ── Step 3: + audio DSP ──
  let audioStream = null;
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    await _delay(500);

    measure('3-+audioDSP', () => {
      renderFrame();
      compCtx.drawImage(glCanvas, 0, 0, W, H);
      if (cameraVideo && cameraVideo.readyState >= 2) {
        compCtx.drawImage(cameraVideo, 0, 0, 120, 120);
      }
    });
  } catch (e) {
    _skip(results, '3-+audioDSP', e.message);
  }

  // ── Step 4: + simulated partner video decode ──
  // Create a fake video stream from a canvas to simulate incoming WebRTC video
  // decode without needing an actual peer connection.
  let fakePartnerVideo = null;
  let fakePartnerStream = null;
  try {
    const fakeCanvas = document.createElement('canvas');
    fakeCanvas.width = 240;
    fakeCanvas.height = 240;
    const fakeCtx = fakeCanvas.getContext('2d');
    // Draw animated noise to force real decode work each frame
    let frame = 0;
    const drawFake = () => {
      fakeCtx.fillStyle = `hsl(${frame++ % 360}, 80%, 50%)`;
      fakeCtx.fillRect(0, 0, 240, 240);
      for (let i = 0; i < 50; i++) {
        fakeCtx.fillStyle = `rgba(${Math.random()*255|0},${Math.random()*255|0},${Math.random()*255|0},0.5)`;
        fakeCtx.fillRect(Math.random()*240|0, Math.random()*240|0, 30, 30);
      }
    };
    drawFake();
    fakePartnerStream = fakeCanvas.captureStream(30);
    fakePartnerVideo = _createVideo(fakePartnerStream);
    await fakePartnerVideo.play();
    // Keep the fake canvas animating so the video stream has new frames
    const fakeInterval = setInterval(drawFake, 33);
    await _delay(500);

    measure('4-+partnerVideo', () => {
      renderFrame();
      compCtx.drawImage(glCanvas, 0, 0, W, H);
      if (cameraVideo && cameraVideo.readyState >= 2) {
        compCtx.drawImage(cameraVideo, 0, 0, 120, 120);
      }
      if (fakePartnerVideo.readyState >= 2) {
        compCtx.drawImage(fakePartnerVideo, W - 120, 0, 120, 120);
      }
    });

    clearInterval(fakeInterval);
  } catch (e) {
    _skip(results, '4-+partnerVideo', e.message);
  }

  // ── Step 5: + full composite (HUD overlay) ──
  measure('5-+fullHUD', () => {
    renderFrame();
    compCtx.drawImage(glCanvas, 0, 0, W, H);
    if (cameraVideo && cameraVideo.readyState >= 2) {
      compCtx.drawImage(cameraVideo, 0, 0, 120, 120);
    }
    if (fakePartnerVideo && fakePartnerVideo.readyState >= 2) {
      compCtx.drawImage(fakePartnerVideo, W - 120, 0, 120, 120);
    }
    // HUD: progress bar, speed, timer, text labels
    compCtx.save();
    compCtx.fillStyle = 'rgba(0,0,0,0.5)';
    compCtx.fillRect(0, 0, W, 28);
    compCtx.font = 'bold 16px sans-serif';
    compCtx.fillStyle = '#fff';
    compCtx.fillText('88 km/h', 12, 20);
    compCtx.fillText('\u23F1 1:23', W - 80, 20);
    compCtx.fillText('1.2 km', W / 2 - 20, 20);
    const grad = compCtx.createLinearGradient(0, 28, W, 28);
    grad.addColorStop(0, '#0f0');
    grad.addColorStop(1, '#f00');
    compCtx.fillStyle = grad;
    compCtx.fillRect(0, 28, W * 0.65, 6);
    // Circular PiP outlines
    compCtx.strokeStyle = '#fff';
    compCtx.lineWidth = 3;
    compCtx.beginPath();
    compCtx.arc(60, 60, 55, 0, Math.PI * 2);
    compCtx.stroke();
    compCtx.beginPath();
    compCtx.arc(W - 60, 60, 55, 0, Math.PI * 2);
    compCtx.stroke();
    compCtx.restore();
  });

  // ── Cleanup ──
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
  if (audioStream) audioStream.getTracks().forEach(t => t.stop());
  if (fakePartnerStream) fakePartnerStream.getTracks().forEach(t => t.stop());
  cleanupGL();

  // ── Analysis: compute deltas ──
  const deltas = [];
  let prevMs = 0;
  for (const r of results) {
    if (r.skipped) {
      deltas.push(r);
    } else {
      deltas.push({ ...r, deltaMs: +(r.avgMs - prevMs).toFixed(2) });
      prevMs = r.avgMs;
    }
  }

  const lastReal = results.filter(r => !r.skipped).pop();
  const finalFps = lastReal ? lastReal.avgFps : 999;
  const lowEnd = finalFps < LOW_END_FPS;

  // Find worst offender
  let worstStep = null;
  if (lowEnd) {
    const realDeltas = deltas.filter(d => !d.skipped);
    worstStep = realDeltas.reduce((a, b) => (b.deltaMs > a.deltaMs ? b : a));
  }

  // ── Pretty-print results ──
  console.log('%c[PERF-PROBE] Results:', 'color:#0af;font-weight:bold');
  console.table(deltas.map(d => d.skipped
    ? { Step: d.step, 'Avg ms': '—', 'Delta ms': '—', FPS: `SKIPPED (${d.reason})` }
    : { Step: d.step, 'Avg ms': d.avgMs, 'Delta ms': d.deltaMs, FPS: d.avgFps }
  ));

  const verdict = lowEnd
    ? `LOW-END (${finalFps.toFixed(0)} fps). Worst offender: ${worstStep.step} (+${worstStep.deltaMs}ms)`
    : `OK (${finalFps.toFixed(0)} fps)`;
  const color = lowEnd ? 'color:#f44;font-weight:bold;font-size:14px' : 'color:#0f0;font-weight:bold;font-size:14px';
  console.log(`%c[PERF-PROBE] Verdict: ${verdict}`, color);
  console.log(`[PERF-PROBE] GPU: ${gpuRenderer}`);

  return { gpuRenderer, steps: deltas, lowEnd, finalFps: +finalFps.toFixed(1), verdict };
}

// ── Helpers ──

function _measure(results, label, workFn, gl, compCtx) {
  for (let i = 0; i < WARMUP; i++) {
    workFn();
    gl.finish();  // force GPU to complete
    compCtx.getImageData(0, 0, 1, 1);  // force 2D readback
  }
  const t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    workFn();
    gl.finish();  // force GPU pipeline flush — without this, draws are deferred
    compCtx.getImageData(0, 0, 1, 1);  // force 2D canvas to actually read pixels
  }
  const elapsed = performance.now() - t0;
  const avgMs = +(elapsed / ITERATIONS).toFixed(2);
  const avgFps = +(1000 / avgMs).toFixed(1);
  results.push({ step: label, avgMs, avgFps });
  console.log(`[PERF-PROBE] ${label}: ${avgMs}ms/frame (${avgFps} fps)`);
}

function _skip(results, label, reason) {
  results.push({ step: label, skipped: true, reason });
  console.log(`[PERF-PROBE] ${label}: SKIPPED (${reason})`);
}

function _createVideo(stream) {
  const v = document.createElement('video');
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  return v;
}

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function getGpuString() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    if (!gl) return 'unknown';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch (e) {
    return 'unknown';
  }
}

export function buildGLScene(gl, W, H) {
  // Vertex shader
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`);
  gl.compileShader(vs);

  // Fragment shader — heavy per-pixel work matching game-recorder's probe
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, `
    precision mediump float;
    varying vec2 v_uv;
    uniform float u_time;

    // Procedural noise to generate texture-like variation without needing an image
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }

    void main() {
      // Multiple octaves of noise (simulates texture lookups)
      float n1 = noise(v_uv * 10.0 + u_time);
      float n2 = noise(v_uv * 20.0 - u_time * 0.7);
      float n3 = noise(v_uv * 40.0 + u_time * 0.3);
      float n4 = noise(v_uv * 80.0 - u_time * 0.5);

      vec3 baseColor = vec3(n1 * 0.4 + 0.3, n2 * 0.5 + 0.2, n3 * 0.3 + 0.4);

      // Fake normal from noise gradient
      vec3 normal = normalize(vec3(
        noise(v_uv * 20.0 + vec2(0.01, 0.0)) - noise(v_uv * 20.0 - vec2(0.01, 0.0)),
        noise(v_uv * 20.0 + vec2(0.0, 0.01)) - noise(v_uv * 20.0 - vec2(0.0, 0.01)),
        0.5
      ));

      // Lighting
      vec3 lightDir = normalize(vec3(0.5, 0.7, 1.0));
      float diff = max(dot(normal, lightDir), 0.15);
      float spec = pow(max(dot(reflect(-lightDir, normal), vec3(0.0, 0.0, 1.0)), 0.0), 32.0);

      vec3 color = baseColor * diff + vec3(spec * 0.5);
      color = mix(color, vec3(n4), 0.1);
      // Gamma
      color = pow(color, vec3(1.0 / 2.2));

      gl_FragColor = vec4(color, 1.0);
    }`);
  gl.compileShader(fs);

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);

  // Full-screen quad
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(prog, 'u_time');
  let t = 0;

  function renderFrame() {
    gl.viewport(0, 0, W, H);
    for (let p = 0; p < 4; p++) {
      gl.uniform1f(uTime, t + p * 0.25);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    t += 0.1;
  }

  function cleanup() {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return { renderFrame, cleanup };
}
