#!/usr/bin/env node
// edit.mjs — cut the trailer from renders/reel/clips/*.mp4 (scripts/reel/shots.mjs) to the in-game track.
//   node scripts/reel/edit.mjs            -> renders/reel/tandemonium-trailer.mp4
// Music: "Krampus Workshop" (Kevin MacLeod, CC BY 4.0), the game's own ride music. ~122.4 bpm,
// a bar is ~1.96 s; the band comes in at 23.6 s, drops out at 70.5 s, last hit at ~84 s.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const R = path.join(ROOT, 'renders', 'reel');
const SEG = path.join(R, 'segments'); fs.mkdirSync(SEG, { recursive: true });
const FONT = 'renders/reel/fonts/LuckiestGuy-Regular.ttf';   // relative: no drive-letter colon to escape
const LOGO = 'images/logo.png';
const MUSIC = 'assets/Krampus Workshop.mp3';
const BAR = 4 * 60 / 122.4;

// [clip, in (s), dur (s), {captions: [[text, from, to, opts]], logo: [from, to], dim, fadeIn, fadeOut}]
const T = [
  ['open', 0.0, 4.0, { fadeIn: 0.6 }],
  ['track', 0.6, 2 * BAR, { captions: [['TWO GEESE.  ONE BIKE.', 0.4, 3.8]] }],
  ['titlebg', 0.0, 2 * BAR, { logo: [0.3, 3.92], dim: 0.25 }],
  ['chase', 1.0, 2 * BAR, { captions: [['PEDAL TOGETHER', 0.3, 3.8]] }],
  ['lean', 0.5, 2 * BAR, { captions: [['LEAN TOGETHER', 0.2, 1.9], ['...OR DON\'T', 2.0, 3.8]] }],
  // one caption held across the three outfit cuts (fades only at its outer ends)
  ['outfit-victorian', 0.4, BAR * 2 / 3, { captions: [['DRESS FOR THE RIDE', 0.1, 9]] }],
  ['outfit-cyclists', 0.4, BAR * 2 / 3, { captions: [['DRESS FOR THE RIDE', -1, 9]] }],
  ['outfit-fancy', 0.4, BAR * 2 / 3, { captions: [['DRESS FOR THE RIDE', -1, BAR * 2 / 3 - 0.05]] }],
  // the band comes in
  ['weave', 1.0, 3 * BAR, { captions: [["TODAY'S ROAD", 0.3, 2.6, { size: 84 }], ['A NEW ROAD EVERY DAY', 2.8, 5.7, { size: 84 }]] }],
  ['colours', 0.0, 2 * BAR, { captions: [['PICK YOUR COLOURS', 0.3, 3.8]] }],
  ['crash', 0.6, 2 * BAR, { captions: [['FALL TOGETHER', 1.4, 3.85]] }],
  ['sling', 0.2, 6 * BAR, { captions: [['SLINGSHOT!', 0.3, 3.4], ['GRAB THE CHAOS COINS', 5.4, 11.5]] }],
  ['versus', 0.5, 5 * BAR, { captions: [['SPLIT-SCREEN  2 v 2', 0.4, 4.5], ['RACE YOUR FRIENDS', 5.0, 9.5]] }],
  ['finish', 0.0, 6 * BAR - 0.1],
  // quiet break
  ['endbg', 0.0, 7 * BAR - 0.2, { captions: [['RIDE ON ONE COUCH', 0.6, 6.4, { size: 84 }], ['OR ONLINE WITH A FRIEND', 7.0, 13.0, { size: 84 }]] }],
  // last hit: end card
  ['endcard', 0, 10.7, { endcard: true, fadeOut: 2.0 }],
];

const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\u2019").replace(/:/g, '\\:').replace(/%/g, '\\%');
// alpha ramp: 0 before a, fade 0.2 s in, hold, fade 0.2 s out by b
const ramp = (a, b, f = 0.2) => `if(lt(t,${a}),0,if(lt(t,${a + f}),(t-${a})/${f},if(lt(t,${b - f}),1,if(lt(t,${b}),(${b}-t)/${f},0))))`;

function drawtext(text, a, b, { size = 96, y = 'h*0.74' } = {}) {
  return `drawtext=fontfile=${FONT}:text='${esc(text)}':fontsize=${size}:fontcolor=0xFFD21F:borderw=7:bordercolor=0x3A1D00:`
    + `shadowcolor=0x000000@0.55:shadowx=0:shadowy=8:x=(w-text_w)/2:y=${y}:alpha='${ramp(a, b)}'`;
}

const segs = [];
let tAt = 0;
for (let i = 0; i < T.length; i++) {
  const [clip, tin, dur, o = {}] = T[i];
  const out = path.join(SEG, String(i).padStart(2, '0') + '-' + clip + '.mp4');
  const vf = [];
  let inputs, filter;
  if (o.endcard) {
    // blurred, darkened last seconds of the end orbit, the logo, the call to action, the music credit
    const src = path.join(R, 'clips', 'endbg.mp4');
    inputs = ['-sseof', '-6', '-i', src, '-loop', '1', '-i', LOGO];
    filter = `[0:v]tpad=stop_mode=clone:stop_duration=10,trim=0:${dur},setpts=PTS-STARTPTS,boxblur=18:2,eq=brightness=-0.18:saturation=0.8[bg];`
      + `[1:v]scale=1100:-1,format=rgba,fade=t=in:st=0.2:d=0.5:alpha=1[lg];`
      + `[bg][lg]overlay=(W-w)/2:H*0.10:shortest=1,`
      + drawtext('WISHLIST NOW ON STEAM', 1.0, dur + 1, { size: 104, y: 'h*0.62' }) + ','
      + `drawtext=fontfile=${FONT}:text='${esc('Music: "Krampus Workshop" Kevin MacLeod (incompetech.com) - CC BY 4.0')}':fontsize=26:fontcolor=white@0.8:x=(w-text_w)/2:y=h*0.92:alpha='${ramp(1.5, dur + 1)}'`
      + (o.fadeOut ? `,fade=t=out:st=${dur - o.fadeOut}:d=${o.fadeOut}` : '') + '[v]';
  } else {
    const src = path.join(R, 'clips', clip + '.mp4');
    inputs = ['-ss', String(tin), '-t', String(dur), '-i', src];
    if (o.logo) inputs.push('-loop', '1', '-i', LOGO);
    vf.push('scale=1920:1080', 'fps=60');
    if (o.dim) vf.push(`eq=brightness=-${o.dim * 0.4}`);
    if (o.fadeIn) vf.push(`fade=t=in:st=0:d=${o.fadeIn}`);
    if (o.fadeOut) vf.push(`fade=t=out:st=${dur - o.fadeOut}:d=${o.fadeOut}`);
    for (const [text, a, b, co = {}] of o.captions || []) vf.push(drawtext(text, a, b, co));
    filter = `[0:v]${vf.join(',')}[c]`;
    if (o.logo) {
      const [a, b] = o.logo;
      filter += `;[1:v]scale=1300:-1,format=rgba,fade=t=in:st=${a}:d=0.4:alpha=1,fade=t=out:st=${b - 0.35}:d=0.35:alpha=1[lg];[c][lg]overlay=(W-w)/2:(H-h)/2-40:shortest=1[v]`;
    } else filter = filter.replace('[c]', '[v]');
  }
  ff([...inputs, '-filter_complex', filter, '-map', '[v]', '-t', String(dur), '-r', '60',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p', '-an', out]);
  segs.push(out);
  console.log(`${tAt.toFixed(2).padStart(6)}  ${clip} (${dur.toFixed(2)} s)`);
  tAt += dur;
}

// concat the segments, then lay the music under them (full track from 0, trimmed, faded at the end)
const list = path.join(SEG, 'list.txt');
fs.writeFileSync(list, segs.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
const silent = path.join(R, 'trailer-video.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
const out = path.join(R, 'tandemonium-trailer.mp4');
ff(['-i', silent, '-i', MUSIC, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
  '-af', `afade=t=out:st=${(tAt - 2).toFixed(2)}:d=2,loudnorm=I=-16:TP=-1.5:LRA=11`, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
  '-t', tAt.toFixed(3), '-movflags', '+faststart', out]);
console.log(`total ${tAt.toFixed(2)} s ->`, out);
