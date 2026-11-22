// After a staging deploy: the pages answer, private files do not, and the build talks to
// staging only.   node scripts/check-staging.mjs [--wait seconds]
const BASE = 'https://tandemonium-staging.housetandem.com';
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
    for (const p of ['/js/config.js', '/js/analytics.js', '/js/remote/pad-protocol.js']) {
      if (PRODUCTION.test(await (await get(p)).text())) bad.push(`${p} names a production address`);
    }
    const home = await get('/');
    if (!(home.headers.get('x-robots-tag') || '').includes('noindex')) bad.push('staging is indexable');
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
console.log(`${BASE}: ${OK.length} pages, ${GONE.length} private paths OK; staging addresses only`);
