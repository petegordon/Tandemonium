// After a deploy: the pages answer, private files do not, media plays on iPhones, other sites can
// read the files, and staging talks to staging only.
//   node scripts/check-staging.mjs [--production] [--wait seconds]
const IS_PRODUCTION = process.argv.includes('--production');
const BASE = IS_PRODUCTION ? 'https://tandemonium.housetandem.com' : 'https://tandemonium-staging.housetandem.com';
const VIDEO = '/goose-stage/reels/watching_victorian_9x16.mp4';
const OK = ['/', '/remote/', '/share/', '/dashboard/', '/js/config.js', '/js/game.js'];
const GONE = ['/package.json', '/README.md', '/docs/', '/worker/leaderboard.js', '/scripts/build-site.mjs', '/electron/main.js'];
const PRODUCTION = /tandemonium-api\.pete|tandemonium-relay\.pete|usersfirst-store\.pete|\/\/api\.housetandem|tandemonium-remote\.housetandem|\/\/tandemonium\.housetandem/;

const waitArg = process.argv.indexOf('--wait');
const waitS = waitArg > 0 ? Number(process.argv[waitArg + 1]) || 0 : 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(BASE + p, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(15000) });

async function problems() {
  const bad = [];
  try {
    for (const p of OK) { const r = await get(p); if (r.status !== 200) bad.push(`${p}: ${r.status}`); }
    for (const p of GONE) { const r = await get(p); if (r.status !== 404) bad.push(`${p} should be 404: ${r.status}`); }
    if (!IS_PRODUCTION) {
      for (const p of ['/js/config.js', '/js/analytics.js', '/js/remote/pad-protocol.js']) {
        if (PRODUCTION.test(await (await get(p)).text())) bad.push(`${p} names a production address`);
      }
    }
    const home = await get('/');
    const noindex = (home.headers.get('x-robots-tag') || '').includes('noindex');
    if (noindex === IS_PRODUCTION) bad.push(IS_PRODUCTION ? 'production is not indexable' : 'staging is indexable');
    if (home.headers.get('access-control-allow-origin') !== '*') bad.push('other sites cannot read the files');
    if (!home.headers.get('x-frame-options')) bad.push('the game page can be framed');
    const lookup = await get('/tourist-lookup.html');
    if (lookup.status !== 200 || lookup.headers.get('x-frame-options')) bad.push('the desktop game cannot embed the Tourist lookup page');
    const part = await fetch(BASE + VIDEO, { headers: { Range: 'bytes=0-1' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const bytes = (await part.arrayBuffer()).byteLength;
    if (part.status !== 206 || bytes !== 2 || !/^bytes 0-1\/\d+$/.test(part.headers.get('content-range') || '')) bad.push(`video range: ${part.status}, ${bytes} bytes`);
  } catch (e) {
    bad.push(`no answer: ${(e.cause && e.cause.code) || e.message}`);
  }
  return bad;
}

const deadline = Date.now() + waitS * 1000;
let bad = await problems();
while (bad.length && Date.now() < deadline) {
  console.log(`Not ready yet (${bad.length}): ${bad[0]}`);
  await sleep(10000);
  bad = await problems();
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log(`${BASE}: ${OK.length} pages, ${GONE.length} private paths, headers and video ranges OK`);
