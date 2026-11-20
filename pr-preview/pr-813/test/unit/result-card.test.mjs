// #657 · the result card: what it says (buildResultCard), its Steam caption,
// the link it carries, and the message SHARE RESULT shows once it is saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResultCard, shareCaption, linkFromStrip, steamSavedMessage,
  CARD_BADGES_MAX, CARD_W, CARD_H,
} from '../../js/result-card.js';
import { buildShareStrip } from '../../js/daily-ride.js';

const DAILY = {
  levelName: 'Daily Ride', levelIcon: '📅', isDaily: true, dayKey: '2026-11-07',
  difficulty: 'adventurous', mode: 'solo', timeMs: 108000, medal: 'bronze',
  collectibles: 5, collectiblesTotal: 8, crashes: 0, tokensEarned: 142,
  badges: [{ icon: '🏁', name: 'Made It' }, { icon: '🥉', name: 'Bronze Age' }, { icon: '📅', name: 'Daily Rider' }],
  link: 'https://tandemonium.housetandem.com/?daily=2026-11-07',
};

test('card size is a 16:9 screenshot', () => {
  assert.equal(CARD_W / CARD_H, 16 / 9);
  assert.ok(CARD_W >= 1280);
});

test('Daily Ride: level · date, difficulty, time, medal', () => {
  const m = buildResultCard(DAILY);
  assert.equal(m.kicker, 'Daily Ride · Nov 7');
  assert.equal(m.icon, '📅');
  assert.deepEqual(m.tags, ['Adventurous']);
  assert.equal(m.time, '1:48');
  assert.equal(m.timeLabel, 'TIME');
  assert.equal(m.medal, 'bronze');
});

test('caption is the strip headline: "Daily Ride · Nov 7 · 1:48 · 🥉"', () => {
  const m = buildResultCard(DAILY);
  assert.equal(m.caption, 'Tandemonium · Daily Ride · Nov 7 · 1:48 · 🥉');
  assert.ok(!m.caption.includes('\n'));
  assert.equal(shareCaption({ kicker: 'Daily Ride · Nov 7', time: '2:41', medal: null, mode: 'pair' }), 'Tandemonium · Daily Ride · Nov 7 · 👥 2:41');
});

test('stats: presents, Tandem Tokens (never coins), clean ride', () => {
  const m = buildResultCard(DAILY);
  const by = Object.fromEntries(m.stats.map(s => [s.kind, s]));
  assert.equal(by.presents.value, '5/8');
  assert.equal(by.tokens.value, '+142');
  assert.equal(by.tokens.label, 'Tandem Tokens');
  assert.ok(!JSON.stringify(m).toLowerCase().includes('coin'));
  assert.equal(by.clean.label, 'Crashes');
  const crashed = buildResultCard({ ...DAILY, crashes: 2 });
  assert.equal(crashed.stats.find(s => s.kind === 'crashes').value, '2');
  const noTokens = buildResultCard({ ...DAILY, tokensEarned: 0 });
  assert.ok(!noTokens.stats.some(s => s.kind === 'tokens'));
});

test("the Daily Ride leads with the day's best, as the strip does", () => {
  const m = buildResultCard({ ...DAILY, timeMs: 128000, bestMs: 118000 });
  assert.equal(m.time, '1:58');
  assert.equal(m.timeLabel, "TODAY'S BEST");
  const slower = buildResultCard({ ...DAILY, timeMs: 100000, bestMs: 118000 });
  assert.equal(slower.time, '1:40');
  assert.equal(slower.timeLabel, 'TIME');
});

test('pair ride names the partner', () => {
  const m = buildResultCard({ ...DAILY, mode: 'pair', partnerName: 'Sam' });
  assert.deepEqual(m.tags, ['Adventurous', 'with Sam']);
  assert.ok(m.caption.includes('👥 1:48'));
});

test('badges: heading, all shown up to the max, then "+n"', () => {
  const m = buildResultCard(DAILY);
  assert.equal(m.badgeHeading, '3 BADGES UNLOCKED');
  assert.equal(m.badges.length, 3);
  assert.equal(m.moreBadges, 0);
  const one = buildResultCard({ ...DAILY, badges: [DAILY.badges[0]] });
  assert.equal(one.badgeHeading, '1 BADGE UNLOCKED');
  const many = Array.from({ length: 20 }, (_, i) => ({ icon: '⭐', name: 'B' + i }));
  const m20 = buildResultCard({ ...DAILY, badges: many });
  assert.equal(m20.badges.length + 1, CARD_BADGES_MAX);   // the last cell is "+n"
  assert.equal(m20.badges.length + m20.moreBadges, 20);
  const m12 = buildResultCard({ ...DAILY, badges: many.slice(0, 12) });
  assert.equal(m12.badges.length, 12);
  assert.equal(m12.moreBadges, 0);
  const none = buildResultCard({ ...DAILY, badges: [] });
  assert.equal(none.badgeHeading, '');
});

test('link: the strip\'s road link, shown without the scheme', () => {
  const strip = buildShareStrip({ key: '2026-11-07', mode: 'solo', timeMs: 108000, medal: 'bronze', distance: 500, raceDistance: 500 },
    { origin: 'https://tandemonium.housetandem.com' });
  const link = linkFromStrip(strip);
  assert.equal(link, 'https://tandemonium.housetandem.com/?daily=2026-11-07');
  assert.equal(buildResultCard({ ...DAILY, link }).linkText, 'tandemonium.housetandem.com/?daily=2026-11-07');
  // The desktop app's own scheme is no link for anyone else.
  assert.equal(linkFromStrip('Tandemonium · Daily Ride\ntandemonium://app/?daily=2026-11-07'), null);
  assert.equal(buildResultCard({ ...DAILY, link: null }).linkText, 'tandemonium.housetandem.com');
});

test('tourist ride: its headline, no medal, no difficulty', () => {
  const m = buildResultCard({ headline: 'Columbus to Grandma', levelName: 'Map Tourist', levelIcon: '📍', timeMs: 200000, link: 'https://tandemonium.housetandem.com/' });
  assert.equal(m.kicker, 'Columbus to Grandma');
  assert.equal(m.medal, null);
  assert.deepEqual(m.tags, []);
  assert.equal(m.caption, 'Tandemonium · Columbus to Grandma · 3:20');
});

test('saved message names the overlay key for keyboard and controller', () => {
  assert.equal(steamSavedMessage(), 'Saved to your Steam screenshots · Shift+Tab to share');
  assert.equal(steamSavedMessage({ pad: true }), 'Saved to your Steam screenshots · Steam button to share');
});
