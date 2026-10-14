// 엔트리 마이페이지 배너(움직이는 SVG, 모션그래픽)를 만든다.
// node make_banner.js → entryroot_banner_1200x210.svg, entryroot_banner_wide.svg
// 엔트리는 배너를 배경 그림(background-size auto, 가운데 정렬)으로 깔아서, 화면 폭에 따라 가운데만 보인다.
// 그래서 글자·아이콘은 가운데(427~773px, 휴대폰 폭 375에서도 보이는 곳)에 두고, 양옆은 장식만 둔다.
// 배경 그림 안에서는 스크립트·바깥 글꼴이 안 돌아서 움직임은 CSS 애니메이션·SMIL, 글꼴은 시스템 글꼴 목록으로 쓴다.
//
// 10초 되풀이: 색 판이 쓸고 지나가며 열림(0~0.8초) → 아이콘이 튀어나오며 터짐, 제목이 위아래에서 들어옴(~2.4초)
// → 머무는 동안 제목에 빛이 두 번 지나가고, 양옆에서 튀는 공(어니언스킨 잔상)과 키프레임 타임라인이 계속 움직임
// → 9초부터 색 판이 다시 덮음. 덮인 순간이 되풀이 이음매라 끊김이 안 보인다.
const fs = require('fs'), path = require('path');

const C = { navy: '#1b2140', deep: '#121733', blue: '#3b6cff', sky: '#6fa0ff', orange: '#ffa424', white: '#ffffff',
  soft: '#b9c4ff', prev: '#ff6b6b', next: '#4da3ff', pink: '#ff5a8a' };
const H = 210, D = 10; // 높이, 되풀이 길이(초)
const FONT = "'Pretendard','Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
const f = n => +n.toFixed(3);
const BACK = 'cubic-bezier(.34,1.56,.64,1)', OUT = 'cubic-bezier(.16,1,.3,1)', INOUT = 'cubic-bezier(.65,0,.35,1)';

// 키프레임 모음. stops: [초, CSS, 다음 구간 이징]
const css = [];
function anim(name, stops, { dur = D, extra = '' } = {}) {
  const body = stops.map(([t, rule, ease]) =>
    `${f(t / dur * 100)}%{${rule}${ease ? `;animation-timing-function:${ease}` : ''}}`).join('');
  css.push(`@keyframes ${name}{${body}}`);
  return `animation:${name} ${dur}s infinite ${extra}`.trim();
}
const style = (rule, box = true) => ` style="${box ? 'transform-box:fill-box;transform-origin:center;' : ''}${rule}"`;

// ── 색 판 쓸기: 앞 판(주황)부터 나가며 열리고, 끝날 땐 뒤 판(남색)부터 들어와 덮는다 ─────────
function panels() {
  const colors = [C.deep, C.blue, C.orange]; // 그리는 순서(뒤 → 앞)
  const W = 3600, cover = -1500, out = 2200, before = cover - W - 200;
  return colors.map((c, i) => {
    const k = colors.length - 1 - i; // 앞 판 k=0
    const a = anim(`pan${i}`, [
      [0, `transform:translateX(${cover}px)`], [k * 0.12, `transform:translateX(${cover}px)`, INOUT],
      [0.5 + k * 0.12, `transform:translateX(${out}px)`], [0.51 + k * 0.12, `transform:translateX(${before}px)`],
      [9 + (2 - k) * 0.1, `transform:translateX(${before}px)`, INOUT], [9.6 + (2 - k) * 0.1, `transform:translateX(${cover}px)`],
      [10, `transform:translateX(${cover}px)`]]);
    return `<polygon points="0,-20 ${W},-20 ${W - 90},${H + 20} -90,${H + 20}" fill="${c}"${style(a, false)}/>`;
  }).join('');
}

// ── 배경: 그라데이션, 떠도는 색 덩어리, 흐르는 빗금, 격자 ───────────────
function background(x0, width) {
  const blob = (id, cx, cy, r, dx, dy, dur) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})"${style(anim(`blob_${id}`, [
      [0, 'transform:translate(0,0)', INOUT], [dur / 2, `transform:translate(${dx}px,${dy}px)`, INOUT], [dur, 'transform:translate(0,0)']], { dur }))}/>`;
  return `<rect x="${x0}" width="${width}" height="${H}" fill="url(#bg)"/>` +
    blob('gb', 300, 60, 340, 160, 40, 9) + blob('go', 960, 190, 300, -140, -30, 11) + blob('gp', 640, 0, 260, 90, 50, 13) +
    `<rect x="${x0}" width="${width}" height="${H}" fill="url(#stripes)"/>` +
    `<rect x="${x0}" width="${width}" height="${H}" fill="url(#grid)"/>`;
}

// ── 가운데: 아이콘 ──────────────────────────────────────────
// 아이콘(76.8) + 사이 20 + 제목(54px) ≈ 346px를 600 가운데로. SPLIT은 Entry|Root 경계(글꼴과 무관하게 붙도록 양쪽 정렬)
const S = 0.8, LEFT = 600 - 173, CX = LEFT + 48 * S, CY = 105, TX = LEFT + 96 * S + 20;
const SPLIT = +(process.env.SPLIT || 652);
function icon() {
  const turn = (begin = 0) => `<animateTransform attributeName="transform" type="rotate" values="-16 55 55;12 55 55;-16 55 55" keyTimes="0;.5;1" dur="1.6s" begin="${begin}s" repeatCount="indefinite" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"/>`;
  const armLayer = (stroke, width) => `<g stroke="${stroke}" stroke-width="${width}"><path d="M40 89 L55 55"/><g>${turn()}<path d="M55 55 L91 43"/></g></g>`;
  // 어니언스킨: 앞 동작은 붉게, 다음 동작은 푸르게(확장의 모양 어니언과 같은 색 약속)
  const ghost = (color, begin) => `<g opacity=".5" stroke="${color}" stroke-width="16" fill="none" stroke-linecap="round"><path d="M40 89 L55 55"/><g>${turn(begin)}<path d="M55 55 L91 43"/></g></g>`;
  const tile = `<rect x="16" y="16" width="96" height="96" rx="24" fill="${C.blue}"/>` +
    `<rect x="16" y="16" width="96" height="96" rx="24" fill="url(#tileShine)"/>` +
    ghost(C.prev, 0.22) + ghost(C.next, -0.22) +
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${armLayer(C.navy, 27)}${armLayer(C.orange, 18)}${armLayer(C.white, 3.5)}</g>` +
    `<circle cx="40" cy="89" r="6.5" fill="${C.white}" stroke="${C.navy}" stroke-width="3"/><circle cx="55" cy="55" r="5.5" fill="${C.white}"/>` +
    `<g>${turn()}<circle cx="91" cy="43" r="5.5" fill="${C.white}"/></g>`;
  const pop = anim('pop', [[0, 'transform:scale(0) rotate(-40deg)'], [0.7, 'transform:scale(0) rotate(-40deg)', BACK],
    [1.25, 'transform:scale(1) rotate(0deg)'], [10, 'transform:scale(1) rotate(0deg)']]);
  // 터짐: 고리 둘 + 뻗는 빛줄
  const ring = (n, delay, color, r) => `<circle cx="${f(CX)}" cy="${CY}" r="${r}" fill="none" stroke="${color}" stroke-width="6"${style(anim(`ring${n}`, [
    [0, 'transform:scale(.2);opacity:0'], [0.85 + delay, 'transform:scale(.2);opacity:1', OUT], [1.6 + delay, 'transform:scale(1);opacity:0'], [10, 'transform:scale(1);opacity:0']]))}/>`;
  const sparks = Array.from({ length: 12 }, (_, i) => {
    const a = i / 12 * Math.PI * 2 + 0.2, r0 = 46, r1 = i % 2 ? 120 : 95;
    return `<line x1="${f(CX + Math.cos(a) * r0)}" y1="${f(CY + Math.sin(a) * r0)}" x2="${f(CX + Math.cos(a) * r1)}" y2="${f(CY + Math.sin(a) * r1)}" stroke="${i % 3 ? C.orange : C.white}" stroke-width="4" stroke-linecap="round" pathLength="100" stroke-dasharray="30 200"${style(anim(`spark${i}`, [
      [0, 'stroke-dashoffset:30;opacity:1'], [0.9, 'stroke-dashoffset:30;opacity:1', OUT], [1.5, 'stroke-dashoffset:-100;opacity:1'], [1.51, 'opacity:0'], [10, 'opacity:0']]), false)}/>`;
  }).join('');
  // 아이콘 둘레 점선 궤도와 그 위를 도는 점
  const orbit = `<g${style(anim('orbitIn', [[0, 'opacity:0'], [1.2, 'opacity:0'], [1.8, 'opacity:1'], [10, 'opacity:1']]), false)}>` +
    `<circle cx="${f(CX)}" cy="${CY}" r="56" fill="none" stroke="${C.soft}" stroke-opacity=".5" stroke-width="1.5" stroke-dasharray="4 7"${style(anim('orbit', [[0, 'transform:rotate(0deg)'], [12, 'transform:rotate(360deg)']], { dur: 12, extra: 'linear' }))}/>` +
    `<g${style(anim('orbitDot', [[0, 'transform:rotate(0deg)'], [4, 'transform:rotate(360deg)']], { dur: 4, extra: 'linear' }))}><circle cx="${f(CX)}" cy="${CY}" r="56" fill="none"/><circle cx="${f(CX + 56)}" cy="${CY}" r="4.5" fill="${C.orange}"/></g></g>`;
  return ring(0, 0, C.white, 70) + ring(1, 0.15, C.orange, 95) + sparks + orbit +
    `<g transform="translate(${f(LEFT - 16 * S)} ${f(CY - 64 * S)}) scale(${S})"><g${style(pop)}>${tile}</g></g>`;
}

// ── 가운데: 제목·부제 ────────────────────────────────────────
function title() {
  const word = (text, anchor, fill, from, t0, id) => `<text x="${SPLIT}" y="111" text-anchor="${anchor}" font-family="${FONT}" font-size="54" font-weight="800" letter-spacing="-1" fill="${fill}"${style(anim(id, [
    [0, `transform:translateY(${from}px)`], [t0, `transform:translateY(${from}px)`, BACK], [t0 + 0.55, 'transform:translateY(0)'], [10, 'transform:translateY(0)']]), false)}>${text}</text>`;
  const words = word('Entry', 'end', C.white, 80, 1.0, 'wordEntry') + word('Root', 'start', C.orange, -80, 1.18, 'wordRoot');
  // 빛: 제목 글자 모양으로 잘린 사선 띠가 두 번 지나간다
  const shine = `<g clip-path="url(#titleClip)"><g transform="skewX(-20)"><rect x="-80" y="40" width="60" height="100" fill="url(#shine)"${style(anim('shine', [
    [0, 'transform:translateX(420px)'], [2.5, 'transform:translateX(420px)', INOUT], [3.2, 'transform:translateX(960px)'], [6.2, 'transform:translateX(960px)'],
    [6.21, 'transform:translateX(420px)', INOUT], [6.9, 'transform:translateX(960px)'], [10, 'transform:translateX(960px)']]), false)}/></g></g>`;
  // 부제: 주황 막대가 왼쪽에서 자라 덮었다가 오른쪽으로 빠지며 글자를 드러낸다
  const capW = 200;
  const bar = `<rect x="${f(TX)}" y="128" width="${capW}" height="20" fill="${C.orange}" style="transform-box:fill-box;transform-origin:left center;${anim('capBar', [
    [0, 'transform:translateX(0) scaleX(0)'], [1.45, 'transform:translateX(0) scaleX(0)', OUT], [1.85, 'transform:translateX(0) scaleX(1)', INOUT],
    [2.3, `transform:translateX(${capW}px) scaleX(0)`], [10, `transform:translateX(${capW}px) scaleX(0)`]])}"/>`;
  const caption = `<text x="${f(TX + 2)}" y="142" font-family="${FONT}" font-size="17" font-weight="600" letter-spacing=".5" fill="${C.soft}"${style(anim('caption', [
    [0, 'opacity:0'], [1.84, 'opacity:0'], [1.85, 'opacity:1'], [10, 'opacity:1']]), false)}>엔트리루트 애니메이터</text>`;
  const dots = [0, 1, 2].map(i => `<circle cx="${f(TX + 196 + i * 15)}" cy="136.5" r="3.5" fill="${C.orange}"${style(anim(`dot${i}`, [
    [0, 'transform:scale(0)'], [2.2 + i * 0.1, 'transform:scale(0)', BACK], [2.5 + i * 0.1, 'transform:scale(1)'], [10, 'transform:scale(1)']]))}>` +
    `<animate attributeName="opacity" values=".3;1;.3" dur="1.2s" begin="${f(i * 0.2)}s" repeatCount="indefinite"/></circle>`).join('');
  const clip = `<clipPath id="titleClip"><text x="${SPLIT}" y="111" text-anchor="end" font-family="${FONT}" font-size="54" font-weight="800" letter-spacing="-1">Entry</text>` +
    `<text x="${SPLIT}" y="111" text-anchor="start" font-family="${FONT}" font-size="54" font-weight="800" letter-spacing="-1">Root</text></clipPath>` +
    `<clipPath id="titleBox"><rect x="${f(TX - 20)}" y="36" width="320" height="96"/></clipPath>`;
  return { defs: clip, body: `<g clip-path="url(#titleBox)">${words}</g>${shine}${caption}${bar}${dots}` };
}

// ── 왼쪽: 튀는 공(늘었다 찌그러짐) + 어니언스킨 잔상(지난 위치는 붉게, 다음 위치는 푸르게) ────
function bouncingBall() {
  const x0 = 175, span = 210, floor = 168, top = 62, B = 0.8, R = 15;
  const hx = anim('ballX', [[0, 'transform:translateX(0);opacity:0'], [0.15, 'transform:translateX(15px);opacity:1'],
    [2.25, `transform:translateX(${span - 15}px);opacity:1`], [2.4, `transform:translateX(${span}px);opacity:0`]], { dur: 2.4, extra: 'linear' });
  const hy = anim('ballY', [[0, 'transform:translateY(0)', 'cubic-bezier(.2,.6,.35,1)'], [B / 2, `transform:translateY(${top - floor}px)`, 'cubic-bezier(.65,0,.8,.4)'], [B, 'transform:translateY(0)']], { dur: B });
  const sq = anim('ballSquash', [[0, 'transform:scale(1.35,.7)', OUT], [0.1, 'transform:scale(.85,1.2)'], [B / 2, 'transform:scale(1,1)'], [B - 0.08, 'transform:scale(.88,1.15)'], [B, 'transform:scale(1.35,.7)']], { dur: B });
  const ball = (fill, delay, op, stroke = '') =>
    `<g opacity="${op}"><g style="${hx};animation-delay:${delay}s"><g style="${hy};animation-delay:${delay}s">` +
    `<circle cx="${x0}" cy="${floor - R}" r="${R}" fill="${fill}"${stroke} style="transform-box:fill-box;transform-origin:50% 100%;${sq};animation-delay:${delay}s"/></g></g></g>`;
  const ghosts = [[-0.3, C.prev, 0.18], [-0.2, C.prev, 0.3], [-0.1, C.prev, 0.45], [0.1, C.next, 0.45], [0.2, C.next, 0.3]]
    .map(([d, c, o]) => ball(c, f(-0.45 - d), o)).join('');
  const shadow = `<g style="${hx};animation-delay:-0.45s"><ellipse cx="${x0}" cy="${floor + 2}" rx="${R + 2}" ry="4" fill="#000" opacity=".35" style="transform-box:fill-box;transform-origin:center;${anim('ballShadow', [
    [0, 'transform:scale(1.2)', 'cubic-bezier(.2,.6,.35,1)'], [B / 2, 'transform:scale(.45)', 'cubic-bezier(.65,0,.8,.4)'], [B, 'transform:scale(1.2)']], { dur: B })};animation-delay:-0.45s"/></g>`;
  const floorLine = `<line x1="${x0 - 30}" y1="${floor + 2}" x2="${x0 + span + 30}" y2="${floor + 2}" stroke="${C.soft}" stroke-opacity=".25" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/>`;
  return floorLine + shadow + ghosts + ball(C.orange, -0.45, 1, ` stroke="${C.white}" stroke-width="3"`);
}

// ── 오른쪽: 키프레임 타임라인. 재생 막대가 지나갈 때 마름모가 반짝이고, 위 네모가 90도씩 튕기며 돈다 ────
function timeline() {
  const x0 = 840, x1 = 1160, y = 156, T = 2.5;
  const keys = [870, 935, 1000, 1065, 1120];
  const hit = x => (x - x0) / (x1 - x0) * T;
  const track = `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${C.soft}" stroke-opacity=".35" stroke-width="3" stroke-linecap="round"/>` +
    Array.from({ length: 17 }, (_, i) => `<line x1="${x0 + i * 20}" y1="${y + 8}" x2="${x0 + i * 20}" y2="${y + (i % 5 ? 12 : 16)}" stroke="${C.soft}" stroke-opacity=".35" stroke-width="1.5"/>`).join('');
  const diamonds = keys.map((x, i) => {
    const t = hit(x);
    const stops = [[0, 'transform:rotate(45deg) scale(1);fill:#ffffff'], [t - 0.02, 'transform:rotate(45deg) scale(1);fill:#ffffff', BACK],
      [t + 0.12, 'transform:rotate(45deg) scale(1.7);fill:#ffa424', OUT], [Math.min(t + 0.5, T), 'transform:rotate(45deg) scale(1);fill:#ffffff']];
    if (stops[stops.length - 1][0] < T) stops.push([T, 'transform:rotate(45deg) scale(1);fill:#ffffff']);
    return `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="2" fill="${C.white}" stroke="${C.navy}" stroke-width="2"${style(anim(`key${i}`, stops, { dur: T }))}/>`;
  }).join('');
  const head = `<g${style(anim('playhead', [[0, 'transform:translateX(0)'], [T, `transform:translateX(${x1 - x0}px)`]], { dur: T, extra: 'linear' }), false)}>` +
    `<line x1="${x0}" y1="${y - 26}" x2="${x0}" y2="${y + 18}" stroke="${C.orange}" stroke-width="3"/><path d="M${x0 - 8} ${y - 34} h16 l-8 10z" fill="${C.orange}"/></g>`;
  // 네모는 90도마다 같은 모양이라, 한 바퀴(450도)에서 처음(0도)으로 돌아가도 튀어 보이지 않는다
  const steps = [[0, 'transform:rotate(0deg)']];
  keys.forEach((x, i) => steps.push([hit(x), `transform:rotate(${i * 90}deg)`, BACK], [hit(x) + 0.3, `transform:rotate(${(i + 1) * 90}deg)`]));
  steps.push([T, `transform:rotate(${keys.length * 90}deg)`]);
  const cube = `<g transform="translate(1000 92)"><rect x="-22" y="-22" width="44" height="44" rx="10" fill="${C.sky}" stroke="${C.white}" stroke-width="3"${style(anim('cube', steps, { dur: T }))}/>` +
    `<circle r="5" fill="${C.white}"/></g>`;
  return track + diamonds + head + cube;
}

// ── 날리는 조각(네모·세모·동그라미·더하기) ─────────────────────
function confetti(x0, x1) {
  let seed = 23;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const colors = [C.orange, C.sky, C.white, C.pink, C.soft];
  const out = [];
  for (let x = x0 + 20; x < x1; x += 46 + rnd() * 60) {
    if (x > 400 && x < 800) continue; // 제목 칸은 비운다
    const y = 20 + rnd() * 170, s = 4 + rnd() * 5, c = colors[Math.floor(rnd() * colors.length)];
    const kind = Math.floor(rnd() * 4), dur = f(5 + rnd() * 6), dy = f(-20 - rnd() * 30), rot = Math.round(180 + rnd() * 360);
    const shape = [
      `<rect x="${f(x - s)}" y="${f(y - s)}" width="${f(s * 2)}" height="${f(s * 2)}" rx="1.5" fill="${c}"/>`,
      `<path d="M${f(x)} ${f(y - s * 1.2)} L${f(x + s * 1.1)} ${f(y + s)} L${f(x - s * 1.1)} ${f(y + s)}Z" fill="none" stroke="${c}" stroke-width="2"/>`,
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s)}" fill="none" stroke="${c}" stroke-width="2"/>`,
      `<path d="M${f(x - s)} ${f(y)}H${f(x + s)}M${f(x)} ${f(y - s)}V${f(y + s)}" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/>`][kind];
    const a = anim(`bit${out.length}`, [[0, 'transform:translateY(0) rotate(0deg);opacity:0'], [dur * 0.15, 'opacity:.85'],
      [dur * 0.85, 'opacity:.85'], [dur, `transform:translateY(${dy}px) rotate(${rot}deg);opacity:0`]], { dur, extra: 'linear' });
    out.push(`<g${style(`${a};animation-delay:${f(-rnd() * dur)}s`)}>${shape}</g>`);
  }
  return out.join('');
}

function build(x0, width) {
  css.length = 0;
  const x1 = x0 + width;
  const bg = background(x0, width), ic = icon(), tt = title(), ball = bouncingBall(), tl = timeline(), bits = confetti(x0, x1), pn = panels();
  const sideIn = anim('sideIn', [[0, 'opacity:0;transform:translateY(16px)'], [1.4, 'opacity:0;transform:translateY(16px)', OUT],
    [2.1, 'opacity:1;transform:translateY(0)'], [10, 'opacity:1;transform:translateY(0)']]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="${x0} 0 ${width} ${H}">
<style>${css.join('')}</style>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f2a63"/><stop offset="1" stop-color="${C.deep}"/></linearGradient>
<radialGradient id="gb"><stop offset="0" stop-color="${C.blue}" stop-opacity=".55"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></radialGradient>
<radialGradient id="go"><stop offset="0" stop-color="${C.orange}" stop-opacity=".3"/><stop offset="1" stop-color="${C.orange}" stop-opacity="0"/></radialGradient>
<radialGradient id="gp"><stop offset="0" stop-color="${C.pink}" stop-opacity=".22"/><stop offset="1" stop-color="${C.pink}" stop-opacity="0"/></radialGradient>
<pattern id="stripes" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(-25)"><path d="M0 0V28" stroke="#fff" stroke-opacity=".035" stroke-width="10"/>
<animateTransform attributeName="patternTransform" type="translate" from="0 0" to="28 0" dur="2s" repeatCount="indefinite" additive="sum"/></pattern>
<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse" y="9"><path d="M24 0H0V24" fill="none" stroke="#fff" stroke-opacity=".045"/></pattern>
<linearGradient id="shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="tileShine" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
${tt.defs}
</defs>
${bg}
${bits}
<g${style(sideIn, false)}>${ball}${tl}</g>
${ic}
${tt.body}
${pn}
</svg>
`;
}

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'entryroot_banner_1200x210.svg'), build(0, 1200));
fs.writeFileSync(path.join(dir, 'entryroot_banner_wide.svg'), build(-660, 2520));
for (const n of ['entryroot_banner_1200x210.svg', 'entryroot_banner_wide.svg'])
  console.log(n, fs.statSync(path.join(dir, n)).size, 'bytes');
