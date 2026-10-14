// 창 없는 크롬으로 로컬 페이지를 열고 시간마다 화면을 PNG로 찍는다.
// node cdp_render.js <page.html|svg> <outDir> <width> <height> <seekExpr: t => JS 식> <t0,t1,...|from:to:step>
const { spawn } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [page, outDir, W, H, seek, times] = process.argv.slice(2);
const list = times.includes(':') ? (() => { const [a, b, s] = times.split(':').map(Number); const r = []; for (let i = 0; a + i * s <= b + 1e-9; i++) r.push(+(a + i * s).toFixed(4)); return r; })() : times.split(',').map(Number);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'evr-promo-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let id = 0, buf = ''; const waiting = new Map();
chrome.stdio[4].on('data', d => { buf += d; let k; while ((k = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
const send = (method, params = {}, sessionId) => new Promise(r => { const n = ++id; waiting.set(n, r); chrome.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
(async () => {
  try {
    const { targetInfos } = (await send('Target.getTargets')).result;
    const S = (await send('Target.attachToTarget', { targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true })).result.sessionId;
    await send('Page.enable', {}, S);
    await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: 1, mobile: false }, S);
    await send('Page.navigate', { url: /^https?:/.test(page) ? page : url.pathToFileURL(path.resolve(page)).href }, S);
    await new Promise(r => setTimeout(r, 1500));
    const ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, S); if (r.result?.exceptionDetails) throw Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
    if (await ev(`typeof window.__ready === 'object' && window.__ready instanceof Promise`)) await ev('window.__ready');
    let i = 0;
    for (const t of list) {
      await ev(`(async () => { (${seek})(${t}); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return 1; })()`);
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: +W, height: +H, scale: 1 } }, S);
      fs.writeFileSync(path.join(outDir, `f${String(i++).padStart(4, '0')}.png`), Buffer.from(shot.result.data, 'base64'));
    }
    console.log('frames', i);
  } catch (e) { console.error('ERR', e.message); process.exitCode = 1; }
  chrome.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(); }, 1200);
})();
