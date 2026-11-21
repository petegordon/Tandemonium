// ============================================================
// BUILD EDITION — which game this copy of the files is
// ============================================================
//
// 'full'  the full game. ?demo=1 (or the desktop app's --demo) still shows the demo, for trying it.
// 'demo'  the demo, whatever the address or launch options say: there is no switch that turns a demo
//         build into the full game.
//
// The repo holds 'full'. A demo build rewrites this one line before packaging:
//   node scripts/set-build-edition.js demo
// (js/edition.js reads it; docs/demo-build.md has the rest of the demo build's plan.)
export const BUILD_EDITION = 'full';
