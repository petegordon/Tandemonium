// VR SOLO RIDE (#425). See docs/vr-solo-ride.md.
import { installAssetBase } from './asset-base.js';
installAssetBase();

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { RideSystem } from './ride-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  world.registerSystem(RideSystem);
  // Our own Enter VR button, shown only where immersive VR is supported.
  const btn = document.getElementById('enter-vr') as HTMLButtonElement;
  let supported = false;
  const show = () => { btn.hidden = !supported || !!world.session; };
  navigator.xr?.isSessionSupported('immersive-vr').then((ok) => { supported = ok; show(); }).catch(() => {});
  btn.addEventListener('click', () => world.launchXR());
  world.visibilityState.subscribe(show);
  if (import.meta.env.DEV) (window as any).__vr = world;   // test hook (dev server only)
});
