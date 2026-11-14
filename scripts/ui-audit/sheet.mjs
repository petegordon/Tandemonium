// node sheet.mjs <dir> <out.png> <prefix>  — 3-col contact sheet of <dir>/<prefix>*.png
import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const [dir, outp, prefix = ''] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.png') && !f.startsWith('sheet')).sort();
const html = `<body style="margin:0;font:13px sans-serif;display:grid;grid-template-columns:repeat(3,640px);gap:4px;background:#fff">` +
  files.map(f => `<div><div>${f}</div><img width=640 height=360 src="data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}"></div>`).join('') + '</body>';
const b = await puppeteer.launch({ headless: 'new' }); const p = await b.newPage();
await p.setViewport({ width: 1928, height: 400 }); await p.setContent(html);
await p.screenshot({ path: outp, fullPage: true }); await b.close(); console.log(files.length, 'files');
