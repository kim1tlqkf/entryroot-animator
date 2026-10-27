// 공개 저장소(GitHub)에 올릴 사본 폴더를 이 저장소에서 맞춘다 — 허용 목록(tools/public-files.js)에 있는 파일만 복사하고, 사본에 남은 목록 밖
// 출시 기록(release/ 아래)은 지우고(원본은 이 저장소에 있음), 그 밖의 목록 밖 파일은 알린다. 마지막에 공개 전 검사(public-copy-check)를 돌려
// 하나라도 걸리면 실패로 끝난다 — 통과 전에는 "올리세요"라고 하지 않는다.
//   node tools/sync-public-copy.js <사본 폴더>
const fs = require('fs'), path = require('path');
const { isPublic } = require('./public-files');
const { check } = require('./public-copy-check');
const root = path.resolve(__dirname, '..');
const dest = process.argv[2] && path.resolve(process.argv[2]);
if (!dest || !fs.existsSync(dest) || dest === root) { console.log('쓰는 법: node tools/sync-public-copy.js <사본 폴더>(이 저장소가 아닌 폴더)'); process.exit(2); }
function* walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (!['.git', 'node_modules', 'tests', 'dist'].includes(entry.name)) yield* walk(path.join(dir, entry.name), name); }
    else yield name;
  }
}
let copied = 0, removed = 0;
for (const name of walk(root)) {
  if (!isPublic(name)) continue;
  const from = path.join(root, name), to = path.join(dest, name);
  if (fs.existsSync(to) && Buffer.compare(fs.readFileSync(from), fs.readFileSync(to)) === 0) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log('복사', name); copied++;
}
const outside = [];
for (const name of walk(dest)) {
  if (isPublic(name)) continue;
  if (name.startsWith('release/') && fs.existsSync(path.join(root, name))) { fs.rmSync(path.join(dest, name)); console.log('지움(공개 안 함, 원본은 저장소에)', name); removed++; }
  else outside.push(name);
}
for (const name of outside) console.log('목록 밖 파일(올리지 마세요)', name);
const hits = check(dest, { publicCopy: true });
for (const hit of hits) console.log(hit);
console.log(`복사 ${copied}개, 지움 ${removed}개 — ${hits.length ? `공개 전 검사 실패 ${hits.length}곳: 고친 뒤 다시 돌리세요` : '공개 전 검사 통과'}`);
process.exit(hits.length ? 1 : 0);
