// 출시 관문 지문(pack.ps1이 같은 방법으로 다시 잰다): 파일 목록을 경로 이름순(서수)으로 "경로:파일SHA256\n" 이어 붙인 글의 SHA256(소문자 16진수).
//   contentHash  zip에 들어갈 확장 파일(manifest.json·rig.js·rig.css·LICENSE·vendor/*·icons/*.png)
//   testsHash    시험(tests/run.js·tests/lib/**·tests/cases/**·tests/fixtures/**) — 전체 시험 뒤 시험·고정 자료를 약하게 고치는 것을 막음
//   harnessHash  시험 + tests/real-server/** + tests/fixture-makers/** + tests/known-limits/** + tools/** + pack.ps1 — 과적합 검토 뒤 시험·탐침·검사·관문을 고치는 것을 막음
//   promptHash   release/overfit-review-prompt.md
//   node tools/gate-hashes.js   지금 저장소의 네 지문을 JSON으로
//   node tools/gate-hashes.js --files <경로…>   그 파일 목록의 지문(미확인 경로 탐침 기록의 probeHash)
//   node tools/gate-hashes.js --scope   harnessHash 범위 목록(JSON)
//   node tools/gate-hashes.js --lib <시험 파일>   그 시험이 쓰는 tests/lib 파일 지문(없으면 빈 줄, lib 글자가 있는데 못 찾으면 오류)
//   node tools/gate-hashes.js --self-test   lib 찾기 자기 점검
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const filesUnder = (root, rel) => {
  const at = path.join(root, rel);
  if (!fs.existsSync(at)) return [];
  return fs.readdirSync(at, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesUnder(root, `${rel}/${entry.name}`) : [`${rel}/${entry.name}`]);
};
function listHash(root, list) {
  const sorted = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha(Buffer.from(sorted.map(f => `${f}:${sha(fs.readFileSync(path.join(root, f)))}\n`).join(''), 'utf8'));
}
const contentFiles = root => ['manifest.json', 'rig.js', 'rig.css', 'LICENSE',
  ...fs.readdirSync(path.join(root, 'vendor')).filter(f => fs.statSync(path.join(root, 'vendor', f)).isFile()).map(f => `vendor/${f}`),
  ...fs.readdirSync(path.join(root, 'icons')).filter(f => f.toLowerCase().endsWith('.png')).map(f => `icons/${f}`)];
const testFiles = root => ['tests/run.js', ...filesUnder(root, 'tests/lib'), ...filesUnder(root, 'tests/cases'), ...filesUnder(root, 'tests/fixtures')];
// harnessHash 범위는 여기 한 곳(끝이 /면 그 아래 모든 파일, release/의 두 파일은 있을 때만) — release/README.md 6절의 지문 범위 줄과 자기 점검이 대조한다
const HARNESS_SCOPE = ['tests/run.js', 'tests/lib/', 'tests/cases/', 'tests/fixtures/', 'tests/real-server/', 'tests/fixture-makers/', 'tests/known-limits/',
  'tools/', 'pack.ps1', 'release/public-accept.txt', 'release/private-terms.txt'];
const harnessFiles = root => HARNESS_SCOPE.flatMap(entry => entry.endsWith('/') ? filesUnder(root, entry.slice(0, -1))
  : entry.startsWith('release/') && !fs.existsSync(path.join(root, entry)) ? [] : [entry]);
const hashes = root => ({
  contentHash: listHash(root, contentFiles(root)),
  testsHash: listHash(root, testFiles(root)),
  harnessHash: listHash(root, harnessFiles(root)),
  promptHash: sha(fs.readFileSync(path.join(root, 'release', 'overfit-review-prompt.md'))),
});
// 시험·탐침 파일이 쓰는 tests/lib 파일 — 고치기 전 판·탐침 기록의 판단이 공용 도구에 있으면 그 도구도 기록에 묶는다(pack.ps1은 이 함수를 node로 부름).
// 자식 node에서 그 파일을 불러 require.cache에 든 tests/lib 파일을 모으고(어떤 require 꼴이든), 글자로 찾은 것(불러오지 않고 run 안에서 부르는 것)을 더한다.
// lib을 가리키는 글자가 있는데 하나도 못 찾으면 막는다
function testLibs(root, file) {
  const seen = new Set(), rel = f => path.relative(root, f).split(path.sep).join('/');
  try {
    const out = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(root, file))}); process.stdout.write(JSON.stringify(Object.keys(require.cache)))`],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    for (const f of JSON.parse(out)) if (rel(f).startsWith('tests/lib/')) seen.add(rel(f));
  } catch { /* 불러오지 못하면 글자로만 */ }
  const queue = [file, ...seen];
  while (queue.length) {
    const at = queue.shift(), text = fs.readFileSync(path.join(root, at), 'utf8'), inLib = at.startsWith('tests/lib/');
    for (const m of text.matchAll(/['"]lib['"]\s*,\s*['"]([\w.-]+?)(?:\.js)?['"]|tests\/lib\/([\w.-]+?)(?:\.js)?['"]|\.\.\/lib\/([\w.-]+?)(?:\.js)?['"]|require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)) {
      const name = m[1] || m[2] || m[3] || (inLib ? m[4] : null), at2 = name && `tests/lib/${name}.js`;
      if (at2 && !seen.has(at2) && fs.existsSync(path.join(root, at2))) { seen.add(at2); queue.push(at2); }
    }
  }
  if (!seen.size && /['"]lib['"]|\.\.\/lib\/|tests\/lib\//.test(fs.readFileSync(path.join(root, file), 'utf8'))) throw Error(`${file}: tests/lib을 쓰는 것 같은데 찾지 못했습니다`);
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
const libHash = (root, file) => { const libs = testLibs(root, file); return libs.length ? listHash(root, libs) : null; };
module.exports = { hashes, listHash, testLibs, libHash, contentHash: root => listHash(root, contentFiles(root)), testsHash: root => listHash(root, testFiles(root)) };
// 자기 점검: 임시 뿌리에 lib 하나와 require 꼴이 다른 시험 넷을 두고 모두 그 lib을 찾는지, lib을 안 쓰는 시험은 빈 목록인지, 못 찾는 글자는 막는지
function selfTest() {
  const os = require('os'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'evr-libs-'));
  try {
    fs.mkdirSync(path.join(root, 'tests', 'lib'), { recursive: true }); fs.mkdirSync(path.join(root, 'tests', 'cases'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'lib', 'helper.js'), "module.exports = () => 1;\n");
    const forms = {
      'join.js': "const h = require(require('path').join(__dirname, '..', 'lib', 'helper.js'));\nmodule.exports = { name: 'join' };\n",
      'relative.js': "const h = require('../lib/helper.js');\nmodule.exports = { name: 'relative' };\n",
      'noext.js': "const h = require(require('path').join(__dirname, '..', 'lib', 'helper'));\nmodule.exports = { name: 'noext' };\n",
      'joined.js': "const h = require(require('path').join(__dirname, '../lib/helper.js'));\nmodule.exports = { name: 'joined' };\n",
      'none.js': "module.exports = { name: 'none' };\n",
      'missing.js': "module.exports = { name: 'missing', async run() { require('../lib/' + 'gone'); } };\n",
    };
    for (const [name, text] of Object.entries(forms)) fs.writeFileSync(path.join(root, 'tests', 'cases', name), text);
    let bad = 0;
    for (const name of ['join.js', 'relative.js', 'noext.js', 'joined.js']) {
      const libs = testLibs(root, `tests/cases/${name}`), ok = libs.length === 1 && libs[0] === 'tests/lib/helper.js';
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(libs)}`); if (!ok) bad++;
    }
    const none = testLibs(root, 'tests/cases/none.js');
    console.log(`${none.length ? 'FAIL' : 'PASS'}  none.js: ${JSON.stringify(none)}`); if (none.length) bad++;
    let threw = false; try { testLibs(root, 'tests/cases/missing.js'); } catch { threw = true; }
    console.log(`${threw ? 'PASS' : 'FAIL'}  missing.js: lib 글자가 있는데 못 찾으면 막음`); if (!threw) bad++;
    if (bad) process.exitCode = 1;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..'), at = process.argv.indexOf('--files');
  const lib = process.argv.indexOf('--lib');
  if (lib >= 0) console.log(libHash(root, process.argv[lib + 1]) || '');
  else if (process.argv.includes('--self-test')) selfTest();
  else if (at >= 0) console.log(listHash(root, process.argv.slice(at + 1)));
  else if (process.argv.includes('--scope')) console.log(JSON.stringify(HARNESS_SCOPE));
  else console.log(JSON.stringify(hashes(root), null, 2));
}
