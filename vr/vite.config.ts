// VR SOLO RIDE (#425): a reference example game on the Meta Immersive Web SDK.
// Built on its own (Vite + IWSDK + super-three 0.181) and served at /vr/ next
// to the flat game, reusing the game's world and bike modules from ../js.
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Game folders the shared modules load from by relative URL ('assets/...'). */
const GAME_DIRS = /^\/(assets|images|tandem-3d)\//;
const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.json': 'application/json',
};

/** Dev only: serve the game's model/texture folders, as /vr/../assets does when deployed. */
function serveGameFiles(): Plugin {
  return {
    name: 'tandemonium-game-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!GAME_DIRS.test(url)) return next();
        const file = normalize(join(REPO_ROOT, decodeURIComponent(url)));
        if (!file.startsWith(normalize(REPO_ROOT)) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] || 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [iwsdkDev(), serveGameFiles()],
  server: { host: '0.0.0.0', port: 8082, open: false, fs: { allow: [REPO_ROOT] } },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  resolve: {
    // Ship only the icons we use instead of all of Lucide (src/ui/lucide-subset.ts).
    alias: [
      {
        find: /^@pmndrs\/uikit-lucide$/,
        replacement: fileURLToPath(new URL('./src/ui/lucide-subset.ts', import.meta.url)),
      },
    ],
    // The game's modules in ../js import 'three' too: resolve it from here
    // (super-three 0.181), never from the repo root's three 0.161.
    dedupe: ['three'],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: ['three'],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
