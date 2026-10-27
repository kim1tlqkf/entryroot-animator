// 과적합 검토 보고서 원문의 저장소 밖 출처 대조: 검토 세션의 보조 에이전트 기록(.jsonl)이 실제 검토 기록의 꼴인지 보고, 돌려준 글(SubagentHandback)의
// sha256(UTF-8 바이트)을 낸다. pack.ps1이 ok와 sha가 기록의 reportHash(저장소 보고서 파일 지문)와 같은지 본다. 이 컴퓨터의 파일은 고쳐 쓸 수 있으므로
// 막는 것이 아니라 위조 비용을 올리는 검사다 — 한 줄짜리 가짜 기록, 머리 지문만 바꾼 사본, 지시문 없이 만든 기록을 가른다.
//   node tools/report-source.js <기록.jsonl> <저장소 뿌리>   → {"ok":…, "problems":[…], "sha":"…"}
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const [file, root] = [process.argv[2], process.argv[3] || path.resolve(__dirname, '..')];
const problems = [], fail = text => problems.push(text);
const home = process.env.USERPROFILE || os.homedir();
// 자리: 집 폴더의 Claude 세션 기록(path.join(집, '.claude', 'projects', 이름표)) 아래 <세션>\subagents\agent-<id>.jsonl, 이름표는 저장소 경로의 영숫자 아닌 글자를 -로
const slug = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
const expectDir = path.join(home, '.claude', 'projects', slug).toLowerCase();
const full = path.resolve(file), name = path.basename(full), sub = path.dirname(full), sessionDir = path.dirname(sub);
const id = (name.match(/^agent-([0-9a-z]+)\.jsonl$/i) || [])[1];
if (!id) fail('기록 파일 이름이 agent-<id>.jsonl이 아님');
if (path.basename(sub).toLowerCase() !== 'subagents' || path.dirname(sessionDir).toLowerCase() !== expectDir) fail(`기록이 이 저장소의 Claude 세션 기록 폴더(${expectDir}\\<세션>\\subagents)에 있지 않음`);
const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
if (lines.some(line => !line)) fail('JSON으로 읽히지 않는 줄이 있음');
const entries = lines.filter(Boolean), messages = entries.filter(entry => ['user', 'assistant', 'attachment'].includes(entry.type));
if (entries.some(entry => entry.agentId !== undefined && entry.agentId !== id)) fail('다른 보조 에이전트의 줄이 섞임');
if (!messages.length || messages.some(entry => entry.agentId !== id || entry.isSidechain !== true)) fail('메시지 줄이 모두 이 보조 에이전트(agentId·isSidechain) 것이 아님');
const blocks = entry => [].concat(entry?.message?.content ?? []).map(block => typeof block === 'string' ? { type: 'text', text: block } : block);
const textOf = entry => blocks(entry).map(block => block.type === 'text' ? block.text : block.type === 'tool_result' ? [].concat(block.content ?? []).map(part => typeof part === 'string' ? part : part?.text || '').join('') : '').join('');
const firstUser = messages.find(entry => entry.type === 'user');
if (!firstUser || !textOf(firstUser).includes('overfit-review-prompt.md')) fail('첫 지시 글이 고정 지시문(overfit-review-prompt.md)을 가리키지 않음');
const uses = messages.filter(entry => entry.type === 'assistant').flatMap(entry => blocks(entry).filter(block => block.type === 'tool_use'));
// node tools/gate-hashes.js(인자 없이) 실행 결과의 네 지문 — 처음 것 = 머리 「검토 시작 지문」, 마지막 것 = 「검토 끝 지문」
// 셸 도구는 이름과 상관없이(Bash·PowerShell 등) 입력 command로 본다
const hashRuns = uses.filter(use => typeof use.input?.command === 'string' && /gate-hashes\.js(?!\s+--)/.test(use.input.command)).map(use => use.id);
const results = new Map();
for (const entry of messages) for (const block of blocks(entry)) if (block.type === 'tool_result') results.set(block.tool_use_id, textOf({ message: { content: [block] } }));
// 고정 지시문을 읽은 기록: 도구와 상관없이(Read·셸 출력) 지시문 파일을 가리킨 호출들의 결과에 지시문의 글 줄이 모두 든다(나눠 읽어도 됨 — 첫 줄만
// 읽은 기록을 가른다)
const promptFile = path.join(root, 'release', 'overfit-review-prompt.md');
const promptLines = (fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '').split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 10);
const promptReads = uses.filter(use => /overfit-review-prompt\.md/.test(JSON.stringify(use.input || {})));
const readText = promptReads.map(use => results.get(use.id) || '').join('\n');
if (!promptLines.length || !promptLines.every(line => readText.includes(line))) fail('고정 지시문을 다 읽은 기록(지시문 파일을 가리킨 도구 호출 결과에 지시문 글 줄이 모두)이 없음');
const KEYS = ['contentHash', 'testsHash', 'harnessHash', 'promptHash'];
const valuesIn = text => { const out = {}; for (const key of KEYS) { const m = String(text).match(new RegExp(`${key}\\W+([0-9a-f]{64})`)); if (m) out[key] = m[1]; } return out; };
const measured = hashRuns.map(runId => valuesIn(results.get(runId) || '')).filter(values => KEYS.every(key => values[key]));
if (measured.length < 1) fail('검토 중에 node tools/gate-hashes.js로 잰 지문 기록이 없음');
const lastUse = uses[uses.length - 1];
if (!lastUse || lastUse.name !== 'SubagentHandback' || typeof lastUse.input?.message !== 'string') fail('마지막 도구 호출이 보고서를 돌려준 SubagentHandback이 아님');
const report = typeof lastUse?.input?.message === 'string' ? lastUse.input.message : '';
const head = { start: null, end: null, base: null };
for (const line of report.split('\n')) {
  if (/^\s*[-*]?\s*\**id\**:\s*`?[A-Za-z0-9._-]+/.test(line)) break;
  if (/검토 시작 지문\**\s*:/.test(line)) head.start = valuesIn(line);
  else if (/검토 끝 지문\**\s*:/.test(line)) head.end = valuesIn(line);
  else if (/검토 바탕 지문\**\s*:/.test(line)) head.base = valuesIn(line);
}
const same = (a, b, keys = KEYS) => !!a && !!b && keys.every(key => a[key] && a[key] === b[key]);
if (measured.length && !(same(head.start, measured[0]) && same(head.end, measured[measured.length - 1]))) fail('보고서 머리 지문이 검토 중 gate-hashes 실행 결과(처음·마지막)와 다름');
// 「검토 바탕 지문」은 검토 중 node tools/gate-hashes.js --root <바탕 판 폴더>로 잰 값이어야 한다
const BASE_KEYS = ['contentHash', 'testsHash', 'harnessHash'];
// (지금 판 지문과 한 명령으로 이어 재면 출력에 지문 묶음이 둘 — 바탕 값 셋이 그 출력에 그대로 들어 있는지로 본다)
const baseRuns = uses.filter(use => typeof use.input?.command === 'string' && /gate-hashes\.js\s+--root\b/.test(use.input.command)).map(use => results.get(use.id) || '');
if (head.base && !(BASE_KEYS.every(key => head.base[key]) && baseRuns.some(out => BASE_KEYS.every(key => out.includes(head.base[key]))))) fail('보고서 「검토 바탕 지문」이 검토 중 gate-hashes --root 실행 결과와 다름');
// 검토에 걸린 시간(분, 첫 줄~마지막 줄 시각) — 관문이 알려 줌
const times = entries.map(entry => Date.parse(entry.timestamp)).filter(Number.isFinite);
const minutes = times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 6000) / 10 : null;
const parent = sessionDir + '.jsonl';
if (!fs.existsSync(parent) || !id || !fs.readFileSync(parent, 'utf8').includes(id)) fail('상위 세션 기록에 이 보조 에이전트가 없음');
const sha = report ? crypto.createHash('sha256').update(Buffer.from(report, 'utf8')).digest('hex') : null;
console.log(JSON.stringify({ ok: !problems.length, problems, sha, minutes }));
