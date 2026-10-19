import { DefaultLoadingManager } from 'three';

// The game's shared modules load models and textures by relative URL
// ('assets/...', 'tandem-3d/...'), written for a page at the site root. This
// page lives at /vr/, so point those URLs one folder up (and at the dev
// server's root in development, see serveGameFiles in vite.config.ts).
const GAME_URL = /^(assets|images|tandem-3d)\//;
const PREFIX = import.meta.env.DEV ? '/' : '../';

export function gameUrl(url: string): string {
  return GAME_URL.test(url) ? PREFIX + url : url;
}

/** Call before any game module loads anything. */
export function installAssetBase(): void {
  DefaultLoadingManager.setURLModifier(gameUrl);
  // The destination house is a <video> (Grandma's chroma-key clip), which
  // doesn't go through a three.js loader: rewrite media src the same way.
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (desc && desc.set && desc.get) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(this: HTMLMediaElement, v: string) { desc.set!.call(this, gameUrl(String(v))); },
    });
  }
}
