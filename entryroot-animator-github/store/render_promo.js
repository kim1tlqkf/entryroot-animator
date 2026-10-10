// promo_small.html을 headless 크롬으로 440×280 PNG(promo_small.png)로 그린다.
// 쓰는 법: node store/render_promo.js  (크롬이 기본 위치에 설치돼 있어야 함)
const { spawn } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const html = path.join(__dirname, 'promo_small.html'), out = path.join(__dirname, 'promo_small.png');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'evr-promo-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-pipe',
  `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let id = 0, buf = ''; const waiting = new Map();
chrome.stdio[4].on('data', d => { buf += d; let k; while ((k = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
const send = (method, params = {}, sessionId) => new Promise(r => { const n = ++id; waiting.set(n, r); chrome.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
(async () => {
  const { targetInfos } = (await send('Target.getTargets')).result;
  const { sessionId } = (await send('Target.attachToTarget', { targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true })).result;
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: 440, height: 280, deviceScaleFactor: 1, mobile: false });
  await s('Page.navigate', { url: 'file:///' + html.replace(/\\/g, '/') });
  await new Promise(r => setTimeout(r, 1200));
  const shot = await s('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 440, height: 280, scale: 1 } });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(out);
  chrome.kill();
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
