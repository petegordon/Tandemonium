// smoke-consent.mjs — the analytics question (EEA, UK, Switzerland) and its Settings switch.
//
//   node scripts/smoke-consent.mjs
//
// Analytics never run on a developer's machine, so the game does not ask here by itself:
// this opens the prompt the way the game does (lobby.askAnalyticsConsent) and checks what a
// player sees and can press, on a phone and on a TV.
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8974, outDir: 'smoke-consent' });
const { check } = h;

const state = (page) => page.evaluate(() => {
  const el = document.getElementById('consent-prompt');
  const card = el.querySelector('.consent-card').getBoundingClientRect();
  const yes = document.getElementById('consent-accept').getBoundingClientRect();
  const no = document.getElementById('consent-decline').getBoundingClientRect();
  return {
    open: el.classList.contains('visible') && getComputedStyle(el).display !== 'none',
    title: document.getElementById('consent-title').textContent,
    text: el.textContent.replace(/\s+/g, ' '),
    fits: card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight,
    sameSize: Math.abs(yes.width - no.width) <= 2 && Math.abs(yes.height - no.height) <= 2,
    tall: Math.min(yes.height, no.height),
    link: (el.querySelector('a') || {}).href,
  };
});

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['tv', { width: 1920, height: 1080 }]]) {
  const page = await h.gamePage({ viewport, storage: { tandemonium_tutorial_done: 'smoke' } });
  await sleep(1500);
  check(!(await state(page)).open, `${name}: the question is not on screen by itself here`);
  await page.evaluate(() => { window.__answer = null; window._game.lobby.askAnalyticsConsent().then((a) => { window.__answer = a; }); });
  await sleep(300);
  const s = await state(page);
  check(s.open && s.fits, `${name}: the question shows and fits the screen`, s);
  check(/never sell/.test(s.text) && /IP address/.test(s.text) && /either way/.test(s.text) && /Settings/.test(s.text), `${name}: it says what is recorded, that play is saved either way, and where to change it`, s.text);
  check(s.sameSize && s.tall >= 40, `${name}: both answers are the same size and easy to press`, s);
  check(s.link === 'https://housetandem.com/privacy', `${name}: it links the privacy policy`, s.link);
  await h.shot(page, `${name}-question`);
  await page.evaluate((n) => document.getElementById(n === 'phone' ? 'consent-decline' : 'consent-accept').click(), name);
  await sleep(200);
  const answer = await page.evaluate(() => window.__answer);
  check(answer === (name === 'phone' ? 'decline' : 'accept'), `${name}: pressing an answer gives it to the game`, answer);
  check(!(await state(page)).open, `${name}: and the question closes`);
  await page.close();
}

await h.finish();
