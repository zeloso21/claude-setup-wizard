// 데모 모드(index.html?demo=1)로 각 단계 화면을 찍는다. server.js 없이 file:// 로 연다.
//   NODE_PATH=$(npm root -g) node scripts/screenshots.js [출력폴더]
// 콘솔 에러/페이지 에러가 하나라도 있으면 종료 코드 1로 끝난다.
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots'));
const PAGE = pathToFileURL(path.join(ROOT, 'public', 'index.html')).href;
const WIDTHS = [1280, 768];
const STEPS = ['install', 'login', 'gmail', 'agent', 'schedule'];
const STATES = ['todo', 'done', 'error'];

const shots = [{ name: 'start', q: 'view=start' }, { name: 'start-checked', q: 'view=start&checked=1' }];
for (const s of STEPS) for (const st of STATES) shots.push({ name: `${s}-${st}`, q: `view=${s}&state=${st}` });
shots.push({ name: 'install-doing', q: 'view=install&state=doing' });
shots.push({ name: 'agent-doing', q: 'view=agent&state=doing' });
shots.push({ name: 'gmail-stuck', q: 'view=gmail&state=todo&stuck=1' });
shots.push({ name: 'finish', q: 'view=finish' });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  let count = 0;
  for (const w of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${w}] console: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[${w}] pageerror: ${e.message}`));
    for (const s of shots) {
      await page.goto(`${PAGE}?demo=1&panel=0&${s.q}`);
      await page.waitForSelector('#view section');
      await page.waitForTimeout(150);
      // 가로 스크롤이 생기면 안 된다(좁은 화면 확인)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) errors.push(`[${w}] ${s.name}: 가로로 ${overflow}px 넘침`);
      await page.screenshot({ path: path.join(OUT, `${s.name}-${w}.png`), fullPage: true });
      count++;
    }
    // 데모 조작판이 보이는 화면도 한 장
    await page.goto(`${PAGE}?demo=1&view=gmail&state=error`);
    await page.waitForSelector('.demo');
    await page.screenshot({ path: path.join(OUT, `demo-panel-${w}.png`) });
    count++;
    await page.close();
  }
  await browser.close();
  console.log(`스크린샷 ${count}장 → ${OUT}`);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('콘솔 에러 0개');
})();
