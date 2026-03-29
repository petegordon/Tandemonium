// ============================================================
// HARDWARE DETECTION — two-tier GPU classification with caching
//
// Tier 1: Instant GPU renderer string matching against known patterns
// Tier 2: Light WebGL probe (Step 1 only — render + gl.finish readback)
//
// Results cached in localStorage for 7 days.
// Threshold and GPU helpers imported from perf-probe.js (single source of truth).
//
// Usage:
//   import { detectHardware, getCachedProfile } from './hardware-detect.js';
//   const cached = getCachedProfile();        // sync, null if no cache
//   const result = await detectHardware();     // async, runs probe if needed
// ============================================================

import { LOW_END_MS, getGpuString, buildGLScene } from './perf-probe.js';

const STORAGE_KEY = 'tandemonium_hardware';
const CACHE_DAYS = 7;

// Known low-end GPU patterns (substring match, case-insensitive)
const LOW_END_PATTERNS = [
  'Intel(R) Graphics',        // Intel N100, N150, N200 integrated
  'Intel(R) UHD Graphics 6',  // UHD 600/610/620/630 (older gen)
  'Mali-G5',                  // ARM Mali G51/G52
  'Adreno 5',                 // Qualcomm Adreno 505/506/508/509
  'PowerVR',                  // Older Apple/Imagination GPUs
];

// Known capable GPU patterns — skip probe
const HIGH_END_PATTERNS = [
  'NVIDIA',
  'Radeon RX',
  'Radeon Pro',
  'Apple M',                  // Apple Silicon
  'Intel(R) Arc',             // Intel discrete
  'Intel(R) Iris(R) Xe',     // Decent Intel integrated
  'Intel(R) UHD Graphics 7',  // UHD 730/770
];

// Light probe constants
const PROBE_ITERATIONS = 10;
const PROBE_WARMUP = 3;

/**
 * Synchronously read cached hardware profile from localStorage.
 * Returns null if no cache or cache expired.
 */
export function getCachedProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const profile = JSON.parse(raw);
    const age = Date.now() - (profile.timestamp || 0);
    if (age > CACHE_DAYS * 24 * 60 * 60 * 1000) return null;
    return profile;
  } catch (e) {
    return null;
  }
}

/**
 * Run hardware detection. Returns cached result if valid,
 * otherwise runs Tier 1 (GPU string) then Tier 2 (light probe) if needed.
 */
export async function detectHardware() {
  const cached = getCachedProfile();
  if (cached) return cached;

  const gpuRenderer = getGpuString();
  let tier = 'unknown';
  let source = 'probe';
  let probeMs = null;

  // Tier 1: GPU string match
  const gpuLower = gpuRenderer.toLowerCase();
  for (const pat of LOW_END_PATTERNS) {
    if (gpuLower.includes(pat.toLowerCase())) {
      tier = 'low';
      source = 'gpu-string';
      break;
    }
  }
  if (tier === 'unknown') {
    for (const pat of HIGH_END_PATTERNS) {
      if (gpuLower.includes(pat.toLowerCase())) {
        tier = 'high';
        source = 'gpu-string';
        break;
      }
    }
  }

  // Tier 2: Light probe (only if string match was inconclusive)
  if (tier === 'unknown') {
    probeMs = _runLightProbe();
    tier = probeMs > LOW_END_MS ? 'low' : 'high';
    source = 'probe';
  }

  const result = { gpuRenderer, tier, source, probeMs, timestamp: Date.now() };

  // Cache result
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  } catch (e) { /* private mode or quota — non-fatal */ }

  console.log(`[HARDWARE] ${tier} (via ${source}) GPU: ${gpuRenderer}${probeMs != null ? ` probe: ${probeMs.toFixed(1)}ms` : ''}`);
  return result;
}

/**
 * Clear cached hardware profile (useful when user selects Auto to re-detect).
 */
export function clearHardwareCache() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}

// ── Light probe (Step 1 only — reuses shared GL scene from perf-probe.js) ──

function _runLightProbe() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  const glCanvas = document.createElement('canvas');
  glCanvas.width = W;
  glCanvas.height = H;
  const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) return 0;

  const { renderFrame, cleanup } = buildGLScene(gl, W, H);

  // Readback target
  const c2d = document.createElement('canvas');
  c2d.width = W; c2d.height = H;
  const ctx = c2d.getContext('2d', { willReadFrequently: true });

  const render = () => {
    renderFrame();
    gl.finish();
    ctx.drawImage(glCanvas, 0, 0, W, H);
    ctx.getImageData(0, 0, 1, 1);
  };

  // Warmup
  for (let i = 0; i < PROBE_WARMUP; i++) render();

  // Measure
  const t0 = performance.now();
  for (let i = 0; i < PROBE_ITERATIONS; i++) render();
  const avg = (performance.now() - t0) / PROBE_ITERATIONS;

  cleanup();
  return avg;
}
