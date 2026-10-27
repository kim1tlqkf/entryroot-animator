// 공개 저장소(GitHub 사본)에 올리기 전에 퍼지면 안 되는 것을 찾는다: 욕설(사용자 원문 인용에 섞임), 엔트리 작품 번호·올린 그림 파일 이름,
// 내 컴퓨터 경로(Windows·Git Bash·Claude 기록 폴더), 이메일, 개인 식별 낱말(공개하지 않는 release/private-terms.txt), --public-copy면 허용 목록
// (tools/public-files.js) 밖 파일. 하나라도 있으면 실패(종료 코드 1). 이것은 바닥 검사다 — 낱말·형태 목록이라 목록 밖은 못 잡으므로 공개 사본은
// 허용 목록으로만 만들고(sync-public-copy.js) 출시 때 과적합 검토가 공개물 전반을 본다. 맨 위 vendor/는 남의 코드라 빼고, 이 파일(심은 예시가
// 들어 있음)은 정확히 tools/public-copy-check.js 경로일 때만 뺀다 — 대신 자기 점검이 이 파일에 욕설·개인 식별 낱말이 없는지 본다.
//   node tools/public-copy-check.js <폴더> [--public-copy] [--private <파일>]
//   node tools/public-copy-check.js --self-test
const fs = require('fs'), path = require('path'), os = require('os');
const { isPublic } = require('./public-files');

const TEXT = /\.(js|json|md|ps1|py|html|css|txt|svg|yml|yaml|log|csv|xml)$|^(LICENSE|\.gitignore)$/i;
const SELF = 'tools/public-copy-check.js';
const DEFAULT_PRIVATE = path.join(__dirname, '..', 'release', 'private-terms.txt');
// 욕설 목록은 이 파일이 공개돼도 보이지 않게 유니코드로 적는다(주석도). 한글 사이의 끼움 글자(GAP)를 지운 글로도 본다(낱말 사이에 숫자·빈칸·
// 기호를 끼운 변형). 출발점을 뜻하는 낱말(\uc2dc\ubc1c\uc810)은 뺀다.
const BAD = ['\uc886', '\uc528\ubc1c', '\uc2dc\ubc1c', '\u3145\u3142', '\u3146\u3142', '\uac1c\uc0c8', '\ubcd1\uc2e0', '\uc0c8\ub07c',
  '\u3148\uac19', '\uc874\ub098', '\u3148\u3134', '\uc305', '\uc5ff\uac19', '\uc9c0\ub784', '\u3142\u3145', '\u3144', '\u3141\u314a', '\uc539',
  '\ubbf8\uce5c\ub188', '\ub2e5\uccd0'];
const PROFANITY = new RegExp([...BAD.map(word => word === '\uc2dc\ubc1c' ? `${word}(?!\uc810)` : word), '\\bfuck', '\\bshit\\b', '\\bbitch', '\\bwtf\\b'].join('|'), 'i');
// 한글 자판(두벌식)을 영문 상태로 친 욕설(계정 이름 속 등): 위 낱말을 자판 글쇠로 바꾼 글과 같은 영문 덩어리. 대소문자는 가리지 않는다(Shift = 된소리).
// 영어 낱말과 겹치지 않게 서·네 글쇠짜리는 덩어리(끼움 글자로 이어진 영문 조각들, 조각 수 제한 없음) 전체나 조각 하나가 같을 때만 — 덩어리 일부로도
// 보면 한 글자 변수를 쉼표로 늘어놓은 코드(w, h, w …)가 걸린다. 다섯 글쇠 이상은 영어와 겹칠 일이 거의 없어 덩어리 어디에 들어 있어도 잡는다(앞·끝만
// 보면 접두·접미를 붙인 계정 이름 꼴 말고는 놓쳤다). 두 글쇠짜리는 뺀다. 끼움 글자는 정해 둔 기호 목록이 아니라 글자(어느 말이든)가 아닌 것 여섯까지다
// (한글 낱말 사이는 넷까지 — 넓히면 "개(1.2 새 기능)" 같은 보통 글이 걸렸다).
// 전각 영문은 반각으로 바꿔 본다(호환 자모가 바뀌는 NFKC는 쓰지 않는다).
const CHO = 'rRseEfaqQtTdwWczxvg';
const JUNG = ['k', 'o', 'i', 'O', 'j', 'p', 'u', 'P', 'h', 'hk', 'ho', 'hl', 'y', 'n', 'nj', 'np', 'nl', 'b', 'm', 'ml', 'l'];
const JONG = ['', 'r', 'R', 'rt', 's', 'sw', 'sg', 'e', 'f', 'fr', 'fa', 'fq', 'ft', 'fx', 'fv', 'fg', 'a', 'q', 'qt', 't', 'T', 'd', 'w', 'c', 'z', 'x', 'v', 'g'];
const COMPAT = ['r', 'R', 'rt', 's', 'sw', 'sg', 'e', 'E', 'f', 'fr', 'fa', 'fq', 'ft', 'fx', 'fv', 'fg', 'a', 'q', 'Q', 'qt', 't', 'T', 'd', 'w', 'W', 'c', 'z', 'x', 'v', 'g', ...JUNG];
const keysOf = word => [...word].map(ch => {
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) { const i = code - 0xac00; return CHO[Math.floor(i / 588)] + JUNG[Math.floor(i % 588 / 28)] + JONG[i % 28]; }
  return code >= 0x3131 && code <= 0x3163 ? COMPAT[code - 0x3131] : '';
}).join('').toLowerCase();
const BAD_KEYS = [...new Set(BAD.map(keysOf))].filter(keys => keys.length >= 3);
const SHORT_KEYS = BAD_KEYS.filter(keys => keys.length < 5), LONG_KEYS = BAD_KEYS.filter(keys => keys.length >= 5);
const MAX_KEYS = Math.max(...LONG_KEYS.map(keys => keys.length));
const GAP = '[^\\p{L}]{1,6}', KO_GAP = '[^\\p{L}]{1,4}';
const halfWidth = line => String(line).replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
const ONLY_GAP = new RegExp(`^${GAP}$`, 'u');
function keyboardProfanity(raw) {
  const line = halfWidth(raw);
  const runs = [...line.matchAll(/[A-Za-z]+/g)];
  const hit = (a, b) => Object.assign([line.slice(runs[a].index, runs[b].index + runs[b][0].length)], { index: runs[a].index });
  for (let start = 0, end; start < runs.length; start = end + 1) {
    for (end = start; end + 1 < runs.length && ONLY_GAP.test(line.slice(runs[end].index + runs[end][0].length, runs[end + 1].index)); end++);
    if (SHORT_KEYS.includes(runs.slice(start, end + 1).map(run => run[0]).join('').toLowerCase())) return hit(start, end);
    for (let i = start; i <= end; i++) {
      if (SHORT_KEYS.includes(runs[i][0].toLowerCase())) return hit(i, i);
      let text = '';
      for (let j = i; j <= end; j++) {
        text += runs[j][0].toLowerCase();
        if (LONG_KEYS.some(keys => text.includes(keys))) return hit(i, j);
        if (text.length - runs[i][0].length >= MAX_KEYS) break; // 더 이어도 첫 조각 뒤로 글쇠 수보다 길어져 맞을 수 없음
      }
    }
  }
  return null;
}
const HANGUL = '\\uac00-\\ud7a3\\u3131-\\u318e';
// 한글 두 글자 사이의 끼움을 지운 글: 글자 아닌 것 넷까지, 같은 글자 되풀이 여덟까지("-----"), 라틴 글자·자모 셋까지 섞인 여섯 글자까지(" X ", "X.",
// "XYZ"). 기호만 다섯 넘게는 지우지 않는다 — "개(1.2 새 기능)" 같은 보통 글이 걸렸다. 분해된 한글(NFD)은 합쳐서 본다.
const GAP_RUN = new RegExp(`(?<=[\uac00-\ud7a3])[^\uac00-\ud7a3]{1,8}(?=[\uac00-\ud7a3])`, 'gu');
const maskGap = gap => {
  const letters = [...gap].filter(ch => /\p{L}/u.test(ch)).length;
  if (!letters) return gap.length <= 4 || new Set(gap).size === 1;
  return letters <= 3 && gap.length <= 6;
};
const squeeze = line => halfWidth(line).normalize('NFC').replace(GAP_RUN, gap => maskGap(gap) ? '' : gap);
// 그림 data URL(data:…;base64,)의 내용은 읽는 글이 아니라 우연히 낱말·자판 꼴이 생긴다 — 그 내용만 같은 길이 빈칸으로 가리고 본다
// (아무 긴 영숫자 덩어리나 가리면 그 안에 숨긴 꼴을 놓친다 — 과적합 검토 8차)
const maskBase64 = line => String(line).replace(/(data:[^;,\s]*;base64,)([A-Za-z0-9+\/=]+)/g, (all, head, body) => head + ' '.repeat(body.length));
const rules = privateTerms => [
  { name: '욕설', find: raw => { const line = maskBase64(raw); return PROFANITY.exec(line) || PROFANITY.exec(squeeze(line)) || keyboardProfanity(line.normalize('NFC')); } },
  { name: '엔트리 작품 번호(24자리)', find: line => /(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/i.exec(line) },
  // 엔트리가 올린 그림에 주는 이름: 16진수 8자 + 영숫자 24자(뒤쪽에 g~z가 섞임 — 해시와 가름)
  { name: '엔트리 그림 파일 이름', find: line => {
    for (const m of line.matchAll(/(?<![0-9a-z])[0-9a-f]{8}([0-9a-z]{24})(?![0-9a-z])/gi)) if (/[g-z]/i.test(m[1])) return m;
    return null;
  } },
  { name: '내 컴퓨터 경로', find: line => /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+|(?<![\w.])\/[a-z]\/Users\/[^/\s"'`]+|AppData[\\/]|~[\\/]\.claude|\.claude[\\/]projects|[A-Za-z]--Users-/i.exec(line) },
  { name: '이메일', find: line => /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/.exec(line) },
  // 글에 섞인 제어 문자(탭·줄바꿈 빼고) — 스크립트로 글을 넣다 \a 같은 이스케이프가 제어 문자로 바뀐 것이 공개 문서에 남았다
  { name: '제어 문자', find: line => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.exec(line) },
  { name: '개인 식별 낱말', find: line => {
    for (const term of privateTerms) { const at = line.toLowerCase().indexOf(term.toLowerCase()); if (at >= 0) return Object.assign([line.slice(at, at + term.length)], { index: at }); }
    return null;
  } },
];
function* walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (!(name === 'vendor' || entry.name === '.git' || entry.name === 'node_modules')) yield* walk(path.join(dir, entry.name), name); }
    else yield { at: path.join(dir, entry.name), name };
  }
}
function readTerms(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}
// 사용자가 알고 그대로 두기로 한 글(공개하지 않는 release/public-accept.txt, 한 줄에 정확한 글 하나 — 탭 뒤는 결정 메모): 막힘 목록
// (release/open-risks.json)에 그 글을 가리키는(publicAccept) accepted 항목(사용자 원문·질문 글)이 있을 때만, 욕설 검사에서만 같은 길이 빈칸으로
// 가린다. 기록 없는 예외 줄은 걸린 곳으로 낸다. 같은 줄의 다른 걸린 곳·다른 규칙(경로·이메일 등)은 그대로 잡는다.
const DEFAULT_ACCEPT = path.join(__dirname, '..', 'release', 'public-accept.txt');
const DEFAULT_RISKS = path.join(__dirname, '..', 'release', 'open-risks.json');
const acceptedText = file => readTerms(file).map(line => line.split('\t')[0]).filter(Boolean);
function decidedText(risksFile) {
  try {
    return new Set((JSON.parse(fs.readFileSync(risksFile, 'utf8')).risks || [])
      .filter(risk => risk.status === 'accepted' && risk.quote && risk.question && risk.publicAccept).map(risk => risk.publicAccept));
  } catch { return new Set(); }
}
const maskAccepted = (line, accepted) => accepted.reduce((text, keep) => text.split(keep).join(' '.repeat(keep.length)), line);
function check(dir, { publicCopy = false, privateFile = DEFAULT_PRIVATE, acceptFile = DEFAULT_ACCEPT, risksFile = DEFAULT_RISKS } = {}) {
  const hits = [], list = rules(readTerms(privateFile)), decided = decidedText(risksFile), listed = acceptedText(acceptFile);
  const accepted = listed.filter(text => decided.has(text));
  for (const text of listed) if (!decided.has(text)) hits.push(`public-accept.txt 예외 '${text.slice(0, 40)}'에 사용자 결정 기록(open-risks publicAccept accepted·원문·질문)이 없습니다`);
  for (const file of walk(dir)) {
    if (publicCopy && !isPublic(file.name) && !file.name.startsWith('vendor/')) hits.push(`${file.name} 공개 목록 밖 파일(tools/public-files.js) — 올리지 마세요`);
    if (!TEXT.test(path.basename(file.name)) || file.name === SELF) continue;
    fs.readFileSync(file.at, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const rule of list) {
        const m = rule.find(rule.name === '욕설' ? maskAccepted(line, accepted) : line);
        if (m) hits.push(`${file.name}:${i + 1} ${rule.name}: …${line.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20)}…`);
      }
    });
  }
  return hits;
}
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evr-public-'));
  // 과적합 검토가 놓친 변형(띄어쓰기·숫자 섞은 욕설, Git Bash 경로, 대문자 번호, .log, 안쪽 vendor 폴더, 개인 식별 낱말)까지 심는다
  const kb = keysOf('\uc2dc\ubc1c'), kb2 = keysOf('\ubcd1\uc2e0'); const kb3 = keysOf('\uc886'); // 세 글쇠짜리 // 자판 변형은 실행할 때 만든다(이 파일에 날글자로 안 둠)
  const planted = [
    ['욕설', 'p1.json', '"report": "흐리게 보이는 \uc886\uac19\uc740 문제!"'],
    ['욕설', 'p2.md', '이거 \uc528 1 \ubc1c 뭐야'],
    ['욕설', 'p3.md', '\uc0c8\ub07c 같은'],
    ['엔트리 작품 번호(24자리)', 'p4.json', '새 작품(0123456789ABCDEF01234567)을 만들고'],
    ['엔트리 그림 파일 이름', 'p5.json', '"filename": "0123abcdmvzz0000000000000000zzzz"'],
    ['내 컴퓨터 경로', 'p6.md', 'C:\\Users\\someone\\Projects\\x'],
    ['내 컴퓨터 경로', 'p7.log', 'cd /c/Users/someone/Projects && ls'],
    ['내 컴퓨터 경로', 'p8.md', '기록: ~/.claude/projects/C--Users-someone-x/abc.jsonl'],
    ['이메일', 'store/vendor/note.md', '연락: someone@example.com'],
    ['제어 문자', 'p10.md', '기록 \\subagents' + String.fromCharCode(7) + 'gent-x.jsonl'],
    ['개인 식별 낱말', 'p9.md', '만든 사람 someoneuser123 님'],
    ['욕설', 'k1.md', `이거 ${kb} 뭐야`],
    ['욕설', 'k2.md', kb.toUpperCase()],
    ['욕설', 'k3.md', `ㅋㅋ ${kb.slice(0, 2)} ${kb.slice(2)}`],
    ['욕설', 'k4.md', `문의: https://github.com/kim1${kb}/some-repo`],
    ['욕설', 'k5.md', `${kb2} 같은`],
    ...['-', '_', '.', '1'].map((mark, i) => ['욕설', `k${6 + i}.md`, `${kb.slice(0, 2)}${mark}${kb.slice(2)}`]),
    ['욕설', 'k10.md', `이거 ${[...kb3].join('.')} 뭐야`],
    ['욕설', 'k11.md', `(${[...kb3].join(', ')})`],
    ['욕설', 'k12.md', `see ${kb3}123abc`],
  ];
  // 끼움 글자 생성 점검: ASCII 문장부호 전부·빈칸·숫자·글자 아닌 유니코드를 2~5조각 사이에 끼운 자판 꼴, 한글 두 글자 사이에 끼운 꼴 — 줄마다 잡아야 한다
  const marks = [' ', '1', '09', '(\u2026)', '\u00b7', '\u2026', '\u3000'];
  for (let c = 33; c < 127; c++) { const ch = String.fromCharCode(c); if (!/[A-Za-z0-9]/.test(ch)) marks.push(ch); }
  const split = (word, n) => Array.from({ length: n }, (_, i) => word.slice(Math.round(i * word.length / n), Math.round((i + 1) * word.length / n)));
  const generated = [];
  for (const word of [kb, kb2]) for (const mark of marks) for (let n = 2; n <= 5; n++) generated.push(split(word, n).join(mark));
  for (const mark of marks) generated.push(`\uc2dc${mark}\ubc1c \uac19\uc740`, `\ubcd1${mark}\uc2e0`);
  // 6차 검토 변형: 영문 덩어리 가운데에 든 꼴, 한글 사이 라틴 글자 가림, 전각 영문, 끼움 5·6글자
  const full = word => [...word].map(ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('');
  for (const word of [kb, kb2]) generated.push(`abc${word}def`, `github.com/zz${word}zz/repo`, `see_${word}_here`, full(word), `${full(word.slice(0, 2))} ${full(word.slice(2))}`,
    split(word, 2).join('-----'), split(word, 2).join('......'));
  generated.push(`\uc528X\ubc1c`, `\uc2dcx\ubc1c 같은`, `\ubcd1Z\uc2e0`, `\uc2dc1\ubc1c`);
  // 7차 검토 변형: 섞인 끼움(빈칸+라틴, 라틴+기호, 라틴 셋), 같은 기호 되풀이 5~8, 자모 끼움, 분해형, 새 낱말
  const mixed = [' X ', 'X.', 'XYZ', ' x1 ', 'a-b', '_Q_', '\u314b', '\u314b\u314b', ' \u314b ', '-----', '........', '~~~~~~', '!!!!!'];
  for (const [a, b] of [['\uc2dc', '\ubc1c'], ['\ubcd1', '\uc2e0'], ['\uac1c', '\uc0c8']]) for (const gap of mixed) generated.push(`이거 ${a}${gap}${b} 뭐야`);
  generated.push('Ab9+'.repeat(30) + kb + 'Q0/='.repeat(5), 'data:image/png;base64,' + 'Ab9+'.repeat(30) + ' \uc528\ubc1c', '\uc2dc\ubc1c'.normalize('NFD'), `이거 ${'\ubcd1\uc2e0'.normalize('NFD')} 뭐야`, '\u3142\u3145 같은', '\u3144', '\u3141\u314a 거', '\uc539 같은', '\ubbf8\uce5c\ub188', '\ub2e5\uccd0', 'what a ' + 'bi' + 'tch', 'w' + 'tf is this');
  for (const [, file, line] of planted) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), line); }
  fs.writeFileSync(path.join(dir, 'gen.md'), generated.join('\n'));
  const clean = ['"contentHash": "' + 'ab'.repeat(32) + '"', '모든 일의 \uc2dc\ubc1c\uc810', 'const maker = tool.brushItemMaker;',
    'https://playentry.org/uploads/…svg?keep/bower_components/#f0', 'node tools/gate-hashes.js',
    'tool fill quick protocol rotor tide whisk', 'https://playentry.org/ws/new', 'tool-fill well_done v1.2.3 a.b.c',
    'The quick brown fox jumps over the lazy dog, then naps (as foxes do).', 'Set w, h to the canvas size; then call fit(x, y, w, h) once.',
    'git log --oneline | head -5 && npm run test -- --watch=false', 'width: 100%; height: auto; margin: 0 4px; border-radius: 2px;',
    'a-b-c d.e.f g_h_i j/k/l m+n o,p q(r)s t=u v w x"y z', 'https://example.com/path?query=1&x=2#frag', 'if (a && b || !c) return [x, y, z];',
    'const { width: w, height: h } = canvas; ctx.drawImage(img, 0, 0, w, h);', '그림 A와 그림 B를 비교하고 모양2를 고른다', 'Fill the shape with RGBA(0,0,0,0.5) then stroke.',
    'Sprite sheets: walk_01.png walk_02.png walk_03.png (rows x cols).', '비트맵 사각 펜·사각 지우개(1.2 새 기능): 펜 끝을 네모로', 'const corners = [[-w, -h], [w, -h], [w, h], [-w, h]];', 'Tools: brush, eraser, fill, select, text, line, rect, circle.',
    'data:image/png;base64,' + 'Ab9+'.repeat(20) + 'h7tLq+p9+w' + 'tf+xYz' + 'Q0/='.repeat(20), '■ 캔버스 크기 · 무한 배경 (1.2 새 기능)', '불이 꺼져 있으면 [켜기]를 누르세요', '그림 A와 그림 B, 모양 X와 Y', '시작(1.2 발표) 뒤', '시간 X 배율'];
  fs.writeFileSync(path.join(dir, 'clean.md'), clean.join('\n'));
  fs.mkdirSync(path.join(dir, 'vendor')); fs.writeFileSync(path.join(dir, 'vendor', 'lib.js'), '// author@example.com');
  const privateFile = path.join(dir, 'private-terms.txt'); fs.writeFileSync(privateFile, '# 공개하지 않는 낱말\nsomeoneuser123\n');
  // 사용자가 그대로 두기로 한 글: 그 글 안에서 걸린 곳만 빼고, 같은 줄의 다른 걸린 곳은 잡는다
  const acceptFile = path.join(dir, 'public-accept.txt'), acceptedUrl = `github.com/kim1${kb}/accepted-repo`, undecidedUrl = `github.com/kim1${kb}/undecided-repo`;
  fs.writeFileSync(acceptFile, `# 자기 점검\n${acceptedUrl}\t자기 점검 결정\n${undecidedUrl}\t기록 없음\n`);
  const risksFile = path.join(dir, 'open-risks.json');
  fs.writeFileSync(risksFile, JSON.stringify({ risks: [{ id: 'selftest', status: 'accepted', quote: '그대로 둠', question: '그대로 둘까요?', publicAccept: acceptedUrl }] }));
  fs.writeFileSync(path.join(dir, 'a3.md'), `문의: https://${undecidedUrl}`);
  fs.writeFileSync(path.join(dir, 'a4.md'), `C:` + String.fromCharCode(92) + `Users` + String.fromCharCode(92) + `someone ${acceptedUrl}`);
  fs.writeFileSync(path.join(dir, 'a1.md'), `문의: https://${acceptedUrl}/issues`);
  fs.writeFileSync(path.join(dir, 'a2.md'), `문의: https://${acceptedUrl} 그리고 ${kb}`);
  const all = check(dir, { privateFile, acceptFile, risksFile });
  const hits = all.filter(h => !h.startsWith('private-terms.txt') && !h.startsWith('public-accept.txt') && !h.startsWith('open-risks.json'));
  let failed = 0;
  for (const [name, file] of planted) if (!hits.some(h => h.startsWith(`${file}:`) && h.includes(` ${name}:`))) { console.log(`FAIL 심은 ${name}(${file})을 못 잡음`); failed++; }
  const missed = generated.filter((line, i) => !hits.some(h => h.startsWith(`gen.md:${i + 1} 욕설:`)));
  if (missed.length) { console.log(`FAIL 끼움 글자 생성 점검 ${missed.length}/${generated.length}줄을 못 잡음(첫 줄 글자 코드: ${[...missed[0]].map(ch => ch.codePointAt(0).toString(16)).join(' ')})`); failed++; }
  if (hits.some(h => h.startsWith('a1.md:'))) { console.log('FAIL 그대로 두기로 한 글을 잡음'); failed++; }
  if (!hits.some(h => h.startsWith('a2.md:'))) { console.log('FAIL 그대로 두기로 한 글 옆의 다른 걸린 곳을 못 잡음'); failed++; }
  if (!hits.some(h => h.startsWith('a3.md:'))) { console.log('FAIL 사용자 결정 기록 없는 예외를 가림'); failed++; }
  if (!all.some(h => h.startsWith('public-accept.txt 예외') && h.includes('undecided'))) { console.log('FAIL 결정 기록 없는 예외 줄을 알리지 않음'); failed++; }
  if (!hits.some(h => h.startsWith('a4.md:') && h.includes('내 컴퓨터 경로'))) { console.log('FAIL 예외 글이 다른 규칙(경로)까지 가림'); failed++; }
  const wrong = hits.filter(h => h.startsWith('clean.md') || h.startsWith('vendor/'));
  if (wrong.length) { console.log('FAIL 문제없는 줄을 잡음:', wrong); failed++; }
  // 허용 목록: 공개 사본 검사에서 출시 기록(release/*.json)은 목록 밖으로 잡히고, README는 안 잡힘
  fs.mkdirSync(path.join(dir, 'release')); fs.writeFileSync(path.join(dir, 'release', 'changes-9.9.9.json'), '{}'); fs.writeFileSync(path.join(dir, 'README.md'), '# 설명');
  const listed = check(dir, { publicCopy: true, privateFile, acceptFile, risksFile });
  if (!listed.some(h => h.startsWith('release/changes-9.9.9.json 공개 목록 밖'))) { console.log('FAIL 출시 기록을 공개 목록 밖으로 못 잡음'); failed++; }
  if (listed.some(h => h.startsWith('README.md 공개 목록 밖'))) { console.log('FAIL README를 목록 밖으로 잡음'); failed++; }
  // 이 파일 이름만 같은 다른 자리의 파일은 빼지 않음
  fs.writeFileSync(path.join(dir, 'public-copy-check.js'), '// 연락: someone@example.com');
  if (!check(dir, { privateFile }).some(h => h.startsWith('public-copy-check.js:1 이메일'))) { console.log('FAIL 이름만 같은 다른 자리 파일을 검사에서 뺌'); failed++; }
  // 검사에서 빠지는 이 파일 자체에 욕설·개인 식별 낱말이 없어야 한다(공개 사본에 그대로 나감)
  const terms = readTerms(DEFAULT_PRIVATE);
  fs.readFileSync(__filename, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (PROFANITY.exec(line) || PROFANITY.exec(squeeze(line)) || terms.some(term => line.toLowerCase().includes(term.toLowerCase()))) { console.log(`FAIL 이 파일 ${i + 1}줄에 욕설·개인 식별 낱말`); failed++; }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `자기 점검 실패 ${failed}` : `자기 점검 통과: 심은 ${planted.length}개·끼움 생성 ${generated.length}줄 모두 잡음, 문제없는 줄 ${clean.length}개·맨 위 vendor는 안 잡음, 허용 목록 밖 기록을 잡음`);
  return failed ? 1 : 0;
}

module.exports = { check };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--self-test') process.exit(selfTest());
  const dir = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--private');
  const at = args.indexOf('--private'), privateFile = at >= 0 ? args[at + 1] : DEFAULT_PRIVATE;
  if (!dir || !fs.existsSync(dir)) { console.log('쓰는 법: node tools/public-copy-check.js <폴더> [--public-copy] [--private <파일>] | --self-test'); process.exit(2); }
  const hits = check(dir, { publicCopy: args.includes('--public-copy'), privateFile });
  for (const hit of hits) console.log(hit);
  console.log(hits.length ? `공개 전 검사 실패: ${hits.length}곳 — 지우고 다시 검사하세요` : '공개 전 검사 통과');
  process.exit(hits.length ? 1 : 0);
}
