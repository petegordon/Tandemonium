import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const [src, dst, ...ids] = process.argv.slice(2);
const b = await puppeteer.launch({ headless: 'new' }); const p = await b.newPage();
await p.setViewport({ width: 1440, height: 810 });
for (const id of ids) {
  const data = fs.readFileSync(path.join(src, id + '.png')).toString('base64');
  await p.setContent(`<body style="margin:0"><img style="display:block;width:1440px;height:810px" src="data:image/png;base64,${data}"></body>`);
  await p.screenshot({ path: path.join(dst, id + '.jpg'), type: 'jpeg', quality: 76 });
}
await b.close();
