// ============================================================
// TRACK MANIFEST — schema + validation for built-in and UGC tracks
// ============================================================

export const SCHEMA_VERSION = 1;
export const MAX_ARTIFACTS = 80;
export const CHECKPOINT_CLEARANCE = 15;   // meters from any checkpoint
export const SAME_TYPE_MIN_SPACING = 8;   // meters between same-type artifacts

// Per-type validators. Each returns { ok: boolean, errors: string[] }.
// Validators also clamp params in-place to the UGC-safe ranges.
const TYPE_SPECS = {
  ramp: {
    defaults: { offset: 0, width: 2.0, length: 3.0, angle: 18, skin: 'wood' },
    ranges: {
      offset: [-2.2, 2.2], width: [1.0, 3.5], length: [1.5, 6.0], angle: [5, 35]
    }
  },
  boost: {
    defaults: { offset: 0, width: 2.5, length: 4.0, strength: 1.35, decay: 0.8, skin: 'chevron' },
    ranges: {
      offset: [-2.2, 2.2], width: [1.5, 4.0], length: [2.0, 8.0],
      strength: [1.1, 1.8], decay: [0.3, 2.0]
    }
  },
  mud: {
    defaults: { offset: 0, width: 1.5, length: 2.5, friction: 0.55, skin: 'mud' },
    ranges: {
      offset: [-2.2, 2.2], width: [1.0, 3.5], length: [1.0, 6.0],
      friction: [0.4, 0.9]
    }
  },
  drawbridge: {
    defaults: { period: 5.0, phase: 0.0, downRatio: 0.6, skin: 'wood' },
    ranges: {
      period: [3.0, 12.0], phase: [0, 12.0], downRatio: [0.4, 0.8]
    }
  },
  choke: {
    defaults: { offset: 0, gap: 2.0, depth: 1.0, mode: 'crash', skin: 'haystack' },
    ranges: { offset: [-1.5, 1.5], gap: [1.2, 3.5], depth: [0.5, 2.0] }
  },
  sync: {
    defaults: { phaseTolerance: 30, rewardStrength: 1.4, rewardDuration: 1.0, skin: 'neon' },
    ranges: {
      phaseTolerance: [15, 60], rewardStrength: [1.1, 1.7], rewardDuration: [0.5, 2.0]
    }
  }
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function applyDefaultsAndClamp(art) {
  const spec = TYPE_SPECS[art.type];
  if (!spec) return { ok: false, errors: [`unknown artifact type: ${art.type}`] };
  // Apply defaults for missing fields
  for (const [k, v] of Object.entries(spec.defaults)) {
    if (art[k] === undefined) art[k] = v;
  }
  // Clamp numeric ranges
  for (const [k, [lo, hi]] of Object.entries(spec.ranges)) {
    if (typeof art[k] === 'number') art[k] = clamp(art[k], lo, hi);
  }
  return { ok: true, errors: [] };
}

/**
 * Validate + normalize a track manifest. Mutates the manifest in place
 * (clamps numeric params to UGC-safe ranges, fills in defaults).
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateManifest(manifest, raceDistance, checkpoints = []) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest is not an object'], warnings };
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}, got ${manifest.schemaVersion}`);
  }
  if (!Array.isArray(manifest.artifacts)) {
    return { ok: false, errors: ['manifest.artifacts must be an array'], warnings };
  }
  if (manifest.artifacts.length > MAX_ARTIFACTS) {
    errors.push(`too many artifacts: ${manifest.artifacts.length} > ${MAX_ARTIFACTS}`);
  }

  // Per-artifact validation
  for (const [i, art] of manifest.artifacts.entries()) {
    if (typeof art.d !== 'number' || art.d < 0 || art.d > raceDistance - 5) {
      errors.push(`#${i} (${art.type}): d=${art.d} must be 0..${raceDistance - 5}`);
      continue;
    }
    const r = applyDefaultsAndClamp(art);
    if (!r.ok) errors.push(`#${i}: ${r.errors.join('; ')}`);
    // Checkpoint clearance (warning, not error — built-in manifests may bend it)
    for (const cp of checkpoints) {
      if (Math.abs(art.d - cp) < CHECKPOINT_CLEARANCE) {
        warnings.push(`#${i} (${art.type}) at d=${art.d} is within ${CHECKPOINT_CLEARANCE}m of checkpoint ${cp}`);
        break;
      }
    }
  }

  // Same-type spacing
  const byType = {};
  for (const art of manifest.artifacts) {
    (byType[art.type] = byType[art.type] || []).push(art);
  }
  for (const [type, items] of Object.entries(byType)) {
    items.sort((a, b) => a.d - b.d);
    for (let i = 1; i < items.length; i++) {
      const gap = items[i].d - items[i - 1].d;
      if (gap < SAME_TYPE_MIN_SPACING) {
        warnings.push(`two ${type} within ${SAME_TYPE_MIN_SPACING}m (d=${items[i - 1].d} and ${items[i].d})`);
      }
    }
  }

  // Cumulative boost budget per 100m segment
  const boosts = manifest.artifacts.filter(a => a.type === 'boost');
  const segCount = Math.max(1, Math.ceil(raceDistance / 100));
  const buckets = new Array(segCount).fill(0);
  for (const b of boosts) {
    const idx = Math.min(segCount - 1, Math.floor(b.d / 100));
    buckets[idx] += (b.strength - 1) * b.length;
  }
  const MAX_BOOST_BUDGET = 6.0;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] > MAX_BOOST_BUDGET) {
      warnings.push(`boost budget exceeded in 100m segment ${i} (${buckets[i].toFixed(2)} > ${MAX_BOOST_BUDGET})`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Fetch + parse + validate a track manifest JSON file.
 * Throws on validation failure (built-in tracks are expected to be valid).
 */
export async function loadManifest(url, raceDistance, checkpoints) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`track manifest ${url}: HTTP ${resp.status}`);
  const manifest = await resp.json();
  const { ok, errors, warnings } = validateManifest(manifest, raceDistance, checkpoints);
  if (warnings.length) {
    console.warn(`[track-manifest] ${url} warnings:`, warnings);
  }
  if (!ok) {
    throw new Error(`track manifest ${url} invalid: ${errors.join('; ')}`);
  }
  return manifest;
}

/** Empty manifest fallback for levels without a track JSON. */
export function emptyManifest(id) {
  return { schemaVersion: SCHEMA_VERSION, id, artifacts: [] };
}
