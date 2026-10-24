// ============================================================
// STUDIO SCENE — renderer, clean backdrop, lights and honk sound for the Goose Studio tools
// ============================================================
//
// A colour-keyed cyclorama (floor curving up into the back wall, no horizon line) with a soft key, fill and
// rim light: reads cleanly on a phone (Pete, 2026-10-15: "clean backdrop").

import * as THREE from 'three';

export const BACKDROPS = {
  victorian: { wall: 0xe9dcc6, floor: 0xd9c8ab },
  cyclists: { wall: 0xcfe3e0, floor: 0xb9d2cd },
  fancy: { wall: 0xf1d5d2, floor: 0xe2bdb8 },
  neutral: { wall: 0xe6e6ea, floor: 0xd2d2d8 },
};

export function createStudio(canvas, { preserve = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: preserve });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  camera.position.set(0, 1.2, 6);

  // cyclorama: a floor that bends up into a wall behind the geese (profile: z along the floor, y up)
  const R = 2.5, W = 40, D = 12, H = 12;
  const prof = [new THREE.Vector2(D, 0)];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI / 2;
    prof.push(new THREE.Vector2(-(D / 2) + R - Math.sin(a) * R, R - Math.cos(a) * R));
  }
  prof.push(new THREE.Vector2(-(D / 2), H));
  const geo = new THREE.BufferGeometry();
  const pos = [], idx = [];
  for (let i = 0; i < prof.length; i++) {
    for (const x of [-W / 2, W / 2]) pos.push(x, prof[i].y, prof[i].x);
  }
  for (let i = 0; i < prof.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const cycMat = new THREE.MeshStandardMaterial({ color: 0xe6e6ea, roughness: 0.95, side: THREE.DoubleSide });
  const cyc = new THREE.Mesh(geo, cycMat);
  cyc.receiveShadow = true;
  scene.add(cyc);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb8a890, 1.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(2.5, 4.5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -4; key.shadow.camera.right = 4;
  key.shadow.camera.top = 4; key.shadow.camera.bottom = -1;
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 15;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 4;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.7);
  fill.position.set(-4, 2, 3);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.2);
  rim.position.set(-1, 3, -4);
  scene.add(rim);

  function setBackdrop(name) {
    const b = BACKDROPS[name] || BACKDROPS.neutral;
    cycMat.color.setHex(b.floor);
    scene.background = new THREE.Color(b.wall);
    hemi.groundColor.setHex(b.floor);
  }
  setBackdrop('neutral');

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return { renderer, scene, camera, setBackdrop, resize, lights: { hemi, key, fill, rim } };
}

/**
 * Goose honks from the game's field recording (assets/goose-honk.mp3): onset-picked windows, the same idea as
 * AudioEngine._playGooseSample. Every honk is logged ({t, offset, rate, gain}) so a captured reel can rebuild
 * the exact sound track offline (scripts/goose-reel.mjs).
 */
export class Honker {
  constructor(url, random = Math.random) {
    this.url = url;
    this.random = random;
    this.log = [];
    this.ctx = null;
    this.buf = null;
    this.onsets = [];
    this.muted = false;
  }

  async load() {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const bytes = await (await fetch(this.url)).arrayBuffer();
      this.buf = await this.ctx.decodeAudioData(bytes);
      this.onsets = findOnsets(this.buf);
    } catch (e) {
      this.buf = null;
    }
    return !!this.buf;
  }

  /** Pick (and log) one honk at reel time t; play it live unless muted. */
  honk(t = 0, gain = 0.9) {
    const n = this.onsets.length;
    const offset = n >= 3 ? this.onsets[Math.floor(this.random() * n)] : this.random() * 16;
    const rate = 0.9 + this.random() * 0.25;
    this.log.push({ t: +t.toFixed(4), offset: +offset.toFixed(4), rate: +rate.toFixed(4), gain, dur: 0.55 });
    if (this.muted || !this.buf || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const now = this.ctx.currentTime, dur = 0.55;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.008);
    g.gain.setValueAtTime(gain, now + dur - 0.05);
    g.gain.linearRampToValueAtTime(0.0001, now + dur);
    src.connect(g).connect(this.ctx.destination);
    src.start(now, offset, dur + 0.02);
  }
}

/** Honk onsets: windowed RMS rising edges with a refractory gap (as AudioEngine._findOnsets). */
export function findOnsets(buf) {
  const data = buf.getChannelData(0), sr = buf.sampleRate;
  const win = Math.floor(sr * 0.02), refractory = Math.floor(sr * 0.22);
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[i]));
  const thresh = peak * 0.3;
  const onsets = [];
  let below = true, last = -refractory;
  for (let i = 0; i + win < data.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += data[j] * data[j];
    const rms = Math.sqrt(sum / win);
    if (rms > thresh) {
      if (below && i - last > refractory) { onsets.push(i / sr); last = i; }
      below = false;
    } else if (rms < thresh * 0.55) below = true;
  }
  return onsets;
}
