# 크롬 웹스토어에 올릴 zip을 dist\ 에 만든다. 확장이 실제로 쓰는 파일만 담는다(README·시험 기록·그림 원본은 뺌).
# 쓰는 법: powershell -ExecutionPolicy Bypass -File pack.ps1
# zip 안 경로는 '/'로 넣는다(Windows PowerShell 5.1의 Compress-Archive는 '\'로 넣는 경우가 있어 쓰지 않음).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = $PSScriptRoot
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'manifest.json') | ConvertFrom-Json
$files = @('manifest.json', 'rig.js', 'rig.css', 'LICENSE') +
  (Get-ChildItem (Join-Path $root 'vendor') -File | ForEach-Object { "vendor/$($_.Name)" }) +
  (Get-ChildItem (Join-Path $root 'icons') -Filter '*.png' -File | ForEach-Object { "icons/$($_.Name)" })

# ---- 출시 관문 ----
# 1.2.0은 사용자의 가벼운 승인과 그때까지의 시험 통과만 믿고 냈다가 숨은 버그가 10개 넘게 나왔다.
# 그래서 zip은 아래가 모두 맞을 때만 만든다. 사용자 승인으로 넘기는 길(옵션)은 두지 않는다.
#  1) release\last-full-run.json — tests\run.js로 이 저장소 확장의 모든 시험을 돌린 기록. 지금 파일 지문(contentHash)·버전이 같고 모두 통과.
#  2) release\review-<버전>.json — 독립 검토 기록. reviewers·scope가 있고, 지적(findings)마다 status가
#     fixed(test = 1)의 기록에서 PASS인 시험 이름) / hardening·wontfix·not-a-bug(reason 필수) 중 하나. open이 하나라도 있으면 안 됨.
#  3) release\changes-<버전>.json — 바뀐 점 출처 기록. 1.2.1의 '작품 저장 확인'은 시험·검토를 다 거쳤지만 원인 미확인 제보에
#     맞춘 짐작 기능이었다.
#     그래서 바뀐 점마다 왜 들어갔는지를 기계가 본다: request(사용자 원문 quote + 확인 시험, 내 선택지에 대한 답이면 premise = 'preference'
#     또는 그 사실 전제를 확인한 시험 이름) / fix(제보 원문 report + reproduced 참 + 확인 시험 + failsBefore — 재현 못 한 고침은 막음) /
#     hardening(새 동작 없음 선언 noNewBehavior 참 + reason — 새 기능을 '예방'이라 부르는 길을 막음) / removal(사용자 원문 quote + reason).
# 지문: 파일 경로 서수 순서로 "경로:파일SHA256(소문자)\n"을 이어 붙인 UTF-8 글의 SHA256 — tests\run.js의 releaseHash와 같은 방법.
function Stop-Release($message) { throw "출시 관문: $message (release\README.md 참고)" }
# 기록의 목록 칸은 이것으로 읽는다 — PowerShell 5.1은 없는 칸을 @()로 감싸면 $null 하나짜리 목록(Count 1)이라 빈 목록 검사가 지나가고 고리가 $null을 돈다
function Get-Items($value) { @($value) | Where-Object { $null -ne $_ } }
# 지문 계산은 tools\gate-hashes.js와 같은 방법(경로 이름순 "경로:SHA256\n" 글의 SHA256)
function Get-ListHash([string[]]$list) {
  $sorted = [string[]]$list.Clone()
  [Array]::Sort($sorted, [StringComparer]::Ordinal)
  $text = ($sorted | ForEach-Object { "$($_):$((Get-FileHash -Algorithm SHA256 (Join-Path $root ($_ -replace '/', '\'))).Hash.ToLower())`n" }) -join ''
  $sha = [System.Security.Cryptography.SHA256]::Create()
  return (($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join '')
}
# 시험·탐침 파일이 쓰는 tests/lib 파일 지문 — 판단이 공용 도구에 있는 확인을 기록 뒤 도구만 고쳐 바꾸지 못하게 고치기 전 판·탐침 기록에 묶는다.
# 찾는 규칙은 tools\gate-hashes.js testLibs 한 곳(실행기와 같음 — 자식 node로 불러 require.cache를 봄). 못 찾으면 막는다
function Get-LibHash([string]$file) {
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & node (Join-Path $root 'tools\gate-hashes.js') --lib $file 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) { Stop-Release "시험($file)이 쓰는 시험 도구(tests/lib)를 찾지 못했습니다: $(($out | Out-String).Trim())" }
  $text = ($out | Out-String).Trim()
  if ($text) { return $text }
  return $null
}
# 검토 보고서 원문의 지적 줄(id: …)과 그 뒤 첫 심각도 줄 — high 지적을 고침 말고 다른 상태로 닫으려면 사용자 결정이 필요하다(과적합 검토 3·4차)
function Read-ReportFindings($path) {
  $ids = @(); $severity = @{}; $current = $null
  foreach ($line in Get-Content -Encoding UTF8 $path) {
    if ($line -match '^\s*[-*]?\s*\**id\**:\s*`?([A-Za-z0-9._-]+)') { $current = $Matches[1]; $ids += $current; continue }
    if ($current -and -not $severity.ContainsKey($current) -and $line -match '심각도\**\s*:\s*\**\s*(high|medium|low)') { $severity[$current] = $Matches[1] }
  }
  return @{ ids = $ids; severity = $severity }
}
# 검토 보고서 맨 앞(첫 지적 줄 전)의 지문 줄 — 「검토 시작 지문」「검토 끝 지문」, 「검토 바탕 지문」(앞 회차가 끝까지 본 판). late: 첫 지적 줄 뒤에 나온 줄 종류
function Read-ReportHead($path) {
  $out = @{ start = @(); end = @(); base = @(); late = $null }; $beforeFirstId = $true
  foreach ($line in Get-Content -Encoding UTF8 $path) {
    if ($line -match '^\s*[-*]?\s*\**id\**:\s*`?[A-Za-z0-9._-]+') { $beforeFirstId = $false }
    $kind = if ($line -match '검토 시작 지문\**\s*:') { 'start' } elseif ($line -match '검토 끝 지문\**\s*:') { 'end' } elseif ($line -match '검토 바탕 지문\**\s*:') { 'base' } else { $null }
    if (-not $kind) { continue }
    if (-not $beforeFirstId) { if (-not $out.late) { $out.late = $kind }; continue }
    $vals = @{}
    foreach ($key in 'contentHash', 'testsHash', 'harnessHash', 'promptHash') { if ($line -match "$key\W+([0-9a-f]{64})\b") { $vals[$key] = $Matches[1] } }
    $out[$kind] += , $vals
  }
  return $out
}
function Get-FilesUnder($rel) {
  $at = Join-Path $root ($rel -replace '/', '\')
  if (-not (Test-Path $at)) { return @() }
  $base = (Resolve-Path $root).Path.TrimEnd('\') + '\'
  return @(Get-ChildItem $at -Recurse -File | ForEach-Object { $_.FullName.Substring($base.Length) -replace '\\', '/' })
}
$contentHash = Get-ListHash $files
$testFiles = @('tests/run.js') + (Get-FilesUnder 'tests/lib') + (Get-FilesUnder 'tests/cases') + (Get-FilesUnder 'tests/fixtures')
# 시험 없는 사본(GitHub 사본 등)은 zip을 만들 곳이 아니다 — 실행기가 없을 때 시험 지문·점검 틀·고치기 전 판 검사를 건너뛰지 않고 막는다
if (-not (Test-Path (Join-Path $root 'tests\run.js'))) { Stop-Release '시험 실행기(tests\run.js)가 없습니다 — 시험 없는 사본에서는 zip을 만들지 않습니다' }
$testsHash = Get-ListHash $testFiles
# 0) release\gate-selftest.json — 관문·도구(pack.ps1·tools/)는 과적합 검토에 묶지 않는다(관문을 고칠 때마다 제품 검토를 다시 받아 출시 회차가 끝나지 않았다).
#    대신 관문 자기 점검(tools\release-gate-selftest.ps1)이 다 통과할 때 남긴 관문 지문(gateHash)이 지금과 같아야 한다. 범위는 tools\gate-hashes.js 한 곳.
$gatePath = Join-Path $root 'release\gate-selftest.json'
if (-not (Test-Path $gatePath)) { Stop-Release '관문 자기 점검 기록(release\gate-selftest.json)이 없습니다 — tools\release-gate-selftest.ps1 을 돌리세요' }
$gateNow = ((& node (Join-Path $root 'tools\gate-hashes.js') --gate) | Out-String).Trim()
if (-not $gateNow -or (Get-Content -Raw -Encoding UTF8 $gatePath | ConvertFrom-Json).gateHash -ne $gateNow) { Stop-Release '관문 자기 점검 뒤 관문·도구(pack.ps1·tools)가 바뀌었습니다(gateHash 다름) — tools\release-gate-selftest.ps1 을 다시 돌리세요' }
$runPath = Join-Path $root 'release\last-full-run.json'
if (-not (Test-Path $runPath)) { Stop-Release '전체 시험 기록이 없습니다 — node tests/run.js 를 먼저 돌리세요' }
$run = Get-Content -Raw -Encoding UTF8 $runPath | ConvertFrom-Json
if ($run.version -ne $manifest.version) { Stop-Release "시험 기록 버전($($run.version))이 manifest($($manifest.version))와 다릅니다" }
if ($run.contentHash -ne $contentHash) { Stop-Release '시험을 돌린 뒤 확장 파일이 바뀌었습니다 — 전체 시험을 다시 돌리세요' }
if (-not $run.allPassed) { Stop-Release '전체 시험에 통과 못 한 것이 있습니다' }
# 시험 파일 지문 — 전체 시험 뒤 시험을 약하게 고치면 막는다(과적합 검토 지적).
if ($run.testsHash -ne $testsHash) { Stop-Release '전체 시험을 돌린 뒤 시험 파일이 바뀌었습니다(testsHash 다름) — 전체 시험을 다시 돌리세요' }
# 시험 폴더의 시험은 모두 이번 기록에 있어야 한다 — 시험을 새로 넣고 전체 시험을 다시 안 돌리면 새 시험이 관문을 거치지 않고 빠졌다(모양 섞임 시험을 넣으며 찾음).
$caseDir = Join-Path $root 'tests\cases'
if (-not $run.caseFiles) { Stop-Release '전체 시험 기록에 시험 파일 목록이 없습니다(예전 기록) — 전체 시험을 다시 돌리세요' }
$notRun = @(Get-ChildItem $caseDir -Filter '*.js' -File | ForEach-Object { $_.Name } | Where-Object { @($run.caseFiles) -notcontains $_ })
if ($notRun.Count) { Stop-Release "전체 시험 기록에 없는 시험이 있습니다($($notRun -join ', ')) — 전체 시험을 다시 돌리세요" }
$reviewPath = Join-Path $root "release\review-$($manifest.version).json"
if (-not (Test-Path $reviewPath)) { Stop-Release "이 버전의 독립 검토 기록(release\review-$($manifest.version).json)이 없습니다" }
$review = Get-Content -Raw -Encoding UTF8 $reviewPath | ConvertFrom-Json
if ($review.version -ne $manifest.version) { Stop-Release '검토 기록의 버전이 다릅니다' }
if (-not $review.reviewers -or -not $review.scope) { Stop-Release '검토 기록에 reviewers·scope가 없습니다' }
$passed = @($run.cases | Where-Object { $_.status -eq 'PASS' } | ForEach-Object { $_.name })
foreach ($finding in @(Get-Items $review.findings)) {
  switch ($finding.status) {
    'fixed' { if (-not $finding.test -or $passed -notcontains $finding.test) { Stop-Release "지적 $($finding.id): 고쳤다는데 확인 시험($($finding.test))이 이번 전체 시험에서 통과하지 않았습니다" } }
    { $_ -in 'hardening', 'wontfix', 'not-a-bug' } { if (-not $finding.reason) { Stop-Release "지적 $($finding.id): $($finding.status)인데 이유(reason)가 없습니다" } }
    'superseded' { if (-not $finding.reason -or -not $finding.quote -or -not $finding.question -or -not $finding.replacedBy) { Stop-Release "지적 $($finding.id): 구현 교체(superseded)는 이유(reason)·사용자 원문(quote)·그때 물은 글(question)·바꾼 요청(replacedBy)이 있어야 닫힙니다" } }
    default { Stop-Release "지적 $($finding.id): 처리되지 않았습니다(status=$($finding.status))" }
  }
}
$changesPath = Join-Path $root "release\changes-$($manifest.version).json"
if (-not (Test-Path $changesPath)) { Stop-Release "이 버전의 바뀐 점 출처 기록(release\changes-$($manifest.version).json)이 없습니다" }
$changes = Get-Content -Raw -Encoding UTF8 $changesPath | ConvertFrom-Json
if ($changes.version -ne $manifest.version) { Stop-Release '바뀐 점 기록의 버전이 다릅니다' }
if (-not @(Get-Items $changes.changes).Count) { Stop-Release '바뀐 점 기록에 항목이 없습니다' }
$passedTest = { param($name) $name -and $passed -contains $name }
foreach ($change in @(Get-Items $changes.changes)) {
  $label = "바뀐 점 $($change.id)"
  if (-not $change.id -or -not $change.summary) { Stop-Release "$label`: id·summary가 없습니다" }
  switch ($change.origin) {
    'request' {
      if (-not $change.quote) { Stop-Release "$label`: 요청인데 사용자 원문(quote)이 없습니다" }
      if (-not (& $passedTest $change.test)) { Stop-Release "$label`: 확인 시험($($change.test))이 이번 전체 시험에서 통과하지 않았습니다" }
      if ($change.fromOption) {
        if (-not $change.premise) { Stop-Release "$label`: 제 선택지에 대한 답인데 전제(premise — 'preference' 또는 전제를 확인한 시험 이름)가 없습니다" }
        if ($change.premise -ne 'preference' -and -not (& $passedTest $change.premise)) { Stop-Release "$label`: 선택지의 사실 전제를 확인한 시험($($change.premise))이 이번 전체 시험에서 통과하지 않았습니다" }
      }
    }
    'fix' {
      if (-not $change.report) { Stop-Release "$label`: 고침인데 제보·발견 내용(report)이 없습니다" }
      if ($change.reproduced -ne $true) { Stop-Release "$label`: 원인을 재현하지 못한 고침입니다 — 재현하거나, 새 동작이 없으면 hardening으로, 아니면 빼세요" }
      if (-not (& $passedTest $change.test)) { Stop-Release "$label`: 확인 시험($($change.test))이 이번 전체 시험에서 통과하지 않았습니다" }
      if (-not $change.failsBefore) { Stop-Release "$label`: 고치기 전 판에서 실패한 기록(failsBefore)이 없습니다" }
    }
    'hardening' {
      if ($change.noNewBehavior -ne $true) { Stop-Release "$label`: 예방 조치는 새 동작·새 화면이 없어야 합니다(noNewBehavior) — 새 기능이면 request나 fix로 근거를 대세요" }
      if (-not $change.reason) { Stop-Release "$label`: 예방 조치인데 이유(reason)가 없습니다" }
    }
    'removal' {
      if (-not $change.quote -or -not $change.reason) { Stop-Release "$label`: 뺀 것인데 사용자 원문(quote)·이유(reason)가 없습니다" }
    }
    default { Stop-Release "$label`: 출처 종류(origin)가 request·fix·hardening·removal이 아닙니다($($change.origin))" }
  }
}
# 구현 교체(superseded): 사용자 결정으로 그 지적이 가리키던 구현을 통째로 바꿔 없앴다 — 그 결정이 이 판의 바뀐 점 기록에 요청(request)으로 있어야 한다
# (요청은 위에서 사용자 원문·이번 전체 시험 PASS 확인 시험을 거침). 지적이 걱정한 것을 새 구현에서 다시 보는 시험(test)을 적었으면 그것도 PASS여야 한다
foreach ($finding in @(Get-Items $review.findings | Where-Object { $_.status -eq 'superseded' })) {
  if (-not @(Get-Items $changes.changes | Where-Object { $_.id -eq $finding.replacedBy -and $_.origin -eq 'request' }).Count) { Stop-Release "지적 $($finding.id): 구현 교체(superseded)가 가리키는 바꾼 요청($($finding.replacedBy))이 바뀐 점 기록에 요청(request)으로 없습니다" }
  if ($finding.test -and -not (& $passedTest $finding.test)) { Stop-Release "지적 $($finding.id): 구현 교체(superseded)에 적은 확인 시험($($finding.test))이 이번 전체 시험에서 통과하지 않았습니다" }
}
# 4) release\open-risks.json — 시험이 닿지 않는 사용자 경로 목록(버전과 상관없이 이어짐). 가짜 서버 시험이 거치지 않는 길(실제 서버 왕복, 확장 없이
#    .ent 열기, 재현 못 한 제보)에서 결함이 나왔다. 항목마다 tested(그 길을 거치는 시험이 이번 전체 시험 PASS — 실제 서버 길(realServer)은 안 됨) /
#    verified(실제 환경 확인 증거 evidence + 사용자 확인 원문 quote + 보여 준 질문 question) / probed(Claude가 실제 환경에서 확인 — evidence +
#    저장소의 탐침 파일 probe) / accepted(사용자가 결과를 알고 받아들인 원문 quote + consequence, 선택지 답이면 question) 중 하나.
#    탐침을 근거로 쓰는 항목(probed, probe가 있는 verified)은 실행기가 남긴 탐침 실행 기록(release\probe-runs.json)에서 그 탐침마다 지금
#    확장 지문·지금 탐침 파일 지문으로 PASS여야 한다(사람이 적은 지문은 믿지 않음 — 과적합 검토 2·3차). tests\known-limits의 시험마다 그것을
#    가리키는(knownLimit) accepted 항목(사용자 원문 + 질문 글)이 있어야 한다. open이 하나라도 남으면 막는다.
$risksPath = Join-Path $root 'release\open-risks.json'
if (-not (Test-Path $risksPath)) { Stop-Release '미확인 경로 목록(release\open-risks.json)이 없습니다' }
$risks = Get-Content -Raw -Encoding UTF8 $risksPath | ConvertFrom-Json
$probeRunsPath = Join-Path $root 'release\probe-runs.json'
$probeRuns = if (Test-Path $probeRunsPath) { Get-Content -Raw -Encoding UTF8 $probeRunsPath | ConvertFrom-Json } else { $null }
$openRisks = @()
foreach ($risk in @(Get-Items $risks.risks)) {
  $label = "미확인 경로 $($risk.id)"
  if (-not $risk.id -or -not $risk.path) { Stop-Release "$label`: id·path가 없습니다" }
  switch ($risk.status) {
    'tested' {
      if ($risk.realServer -eq $true) { Stop-Release "$label`: 실제 서버 길은 가짜 서버 시험으로 닫을 수 없습니다 — verified(실제 확인) 또는 accepted로" }
      if (-not (& $passedTest $risk.test)) { Stop-Release "$label`: 확인했다는 시험($($risk.test))이 이번 전체 시험에서 통과하지 않았습니다" }
    }
    'verified' {
      if (-not $risk.evidence -or -not $risk.quote) { Stop-Release "$label`: 실제로 확인했다는데 증거(evidence)·사용자 확인 원문(quote)이 없습니다" }
      if (-not $risk.question) { Stop-Release "$label`: 사용자 확인인데 무엇을 보여 주고 물었는지(question)가 없습니다 — 위임('다 해줘' 등)은 확인이 아닙니다" }
    }
    'probed' {
      if (-not $risk.evidence -or -not @(Get-Items $risk.probe).Count) { Stop-Release "$label`: 실제 환경 탐침인데 증거(evidence)·탐침 파일(probe)이 없습니다" }
    }
    'accepted' {
      if (-not $risk.quote -or -not $risk.consequence) { Stop-Release "$label`: 받아들였다는데 사용자 원문(quote)·결과 설명(consequence)이 없습니다" }
      if ($risk.fromOption -and -not $risk.question) { Stop-Release "$label`: 선택지에 대한 답인데 그 질문 글(question)이 없습니다" }
    }
    default { $openRisks += "$($risk.id)" }
  }
  if ($risk.status -in 'probed', 'verified' -and @(Get-Items $risk.probe).Count) {
    foreach ($file in @(Get-Items $risk.probe)) {
      if (-not (Test-Path (Join-Path $root ($file -replace '/', '\')))) { Stop-Release "$label`: 탐침 파일($file)이 저장소에 없습니다" }
      $probeRun = if ($probeRuns -and $probeRuns.runs) { $probeRuns.runs.PSObject.Properties[$file].Value } else { $null }
      if (-not $probeRun) { Stop-Release "$label`: 탐침($file)을 실행한 기록이 없습니다(release\probe-runs.json — node tests/run.js --cases=tests/real-server)" }
      if ($probeRun.status -ne 'PASS') { Stop-Release "$label`: 탐침($file)이 통과하지 않았습니다($($probeRun.status))" }
      if ($probeRun.contentHash -ne $contentHash) { Stop-Release "$label`: 탐침($file)을 지금 확장 파일로 돌린 기록이 아닙니다 — 다시 돌리세요" }
      if ($probeRun.fileHash -ne (Get-ListHash @($file))) { Stop-Release "$label`: 탐침을 돌린 뒤 탐침 파일($file)이 바뀌었습니다 — 다시 돌리세요" }
      if ([string]$probeRun.libHash -ne [string](Get-LibHash $file)) { Stop-Release "$label`: 탐침을 돌린 뒤 그 탐침이 쓰는 시험 도구(tests/lib)가 바뀌었거나 기록에 도구 지문(libHash)이 없습니다 — 다시 돌리세요" }
    }
  }
}
$knownDir = Join-Path $root 'tests\known-limits'
if (Test-Path $knownDir) {
  foreach ($name in @(Get-ChildItem $knownDir -Filter '*.js' -File | ForEach-Object { $_.Name })) {
    $rel = "tests/known-limits/$name"
    $owners = @($risks.risks | Where-Object { $_.knownLimit -eq $rel })
    if (-not $owners.Count) { Stop-Release "알려진 한계 시험($rel)을 가리키는 미확인 경로 항목(knownLimit)이 없습니다 — 사용자 결정 없이 한계로 두지 않습니다" }
    if (-not @($owners | Where-Object { $_.status -eq 'accepted' -and $_.question }).Count) { Stop-Release "알려진 한계($rel)는 사용자가 결과를 알고 받아들인 기록(accepted + quote + question)이어야 합니다" }
  }
}
if ($openRisks.Count) { Stop-Release "확인 못 한 사용자 경로가 남아 있습니다($($openRisks -join ', ')) — release\open-risks.json" }
# 5) release\overfit-review-<버전>.json — 과적합·편향 공격 검토. 고침·시험·검사가 눈앞의 사례 하나에 맞춰진 채 나갔다(1.2.1 작품 저장 확인,
#    1.3.1 공개 사본 검사가 그 사고에서 본 종류만 잡음). 작성자와 다른 검토자가 고정 지시문(overfit-review-prompt.md)으로
#    공격적으로 검토한 기록이어야 한다: 지시문 지문(promptHash)이 지금 지시문과 같고(검토 범위를 몰래 줄이지 않게), 확장 파일 지문(contentHash)이 지금과
#    같고(고친 뒤 다시 검토), 확인한 곳 목록(checked)이 있고, 지적마다 fixed(이번 전체 시험 PASS인 test)·hardening·wontfix·not-a-bug(reason) 중 하나.
#    검토자 보고서 원문을 그대로 둔 파일(report, reportHash)이 있고 그 보고서의 지적 줄(id: …)이 모두 기록에 있어야 한다 — 작성자가 지적을 빼고
#    옮겨 적는 길을 막는다(과적합 검토 지적).
$promptPath = Join-Path $root 'release\overfit-review-prompt.md'
if (-not (Test-Path $promptPath)) { Stop-Release '과적합 검토 지시문(release\overfit-review-prompt.md)이 없습니다' }
$promptHash = (Get-FileHash -Algorithm SHA256 $promptPath).Hash.ToLower()
$overfitPath = Join-Path $root "release\overfit-review-$($manifest.version).json"
if (-not (Test-Path $overfitPath)) { Stop-Release "이 버전의 과적합 검토 기록(release\overfit-review-$($manifest.version).json)이 없습니다 — 고정 지시문으로 다른 검토자에게 맡기세요" }
$overfit = Get-Content -Raw -Encoding UTF8 $overfitPath | ConvertFrom-Json
if ($overfit.version -ne $manifest.version) { Stop-Release '과적합 검토 기록의 버전이 다릅니다' }
if (-not $overfit.reviewer) { Stop-Release '과적합 검토 기록에 검토자(reviewer)가 없습니다' }
if ($overfit.promptHash -ne $promptHash) { Stop-Release '과적합 검토가 지금 지시문으로 한 것이 아닙니다(promptHash 다름) — 지시문을 바꿨으면 다시 검토하세요' }
if ($overfit.contentHash -ne $contentHash) { Stop-Release '과적합 검토 뒤 확장 파일이 바뀌었습니다(contentHash 다름) — 다시 검토하세요' }
# 범위는 tools\gate-hashes.js HARNESS_SCOPE 한 곳(여기서 목록을 따로 두면 둘이 어긋나도 모름)
$harnessHash = ((& node (Join-Path $root 'tools\gate-hashes.js')) | Out-String | ConvertFrom-Json).harnessHash
if (-not $harnessHash -or $overfit.harnessHash -ne $harnessHash) { Stop-Release '과적합 검토 뒤 시험·탐침이 바뀌었습니다(harnessHash 다름) — 다시 검토하세요' }
if (-not @(Get-Items $overfit.checked).Count) { Stop-Release '과적합 검토 기록에 확인한 곳(checked)이 없습니다' }
if (-not $overfit.report) { Stop-Release '과적합 검토 기록에 검토자 보고서 원문 파일(report)이 없습니다' }
$reportPath = Join-Path $root ($overfit.report -replace '/', '\')
if (-not (Test-Path $reportPath)) { Stop-Release "과적합 검토 보고서 원문($($overfit.report))이 없습니다" }
if ($overfit.reportHash -ne (Get-FileHash -Algorithm SHA256 $reportPath).Hash.ToLower()) { Stop-Release '과적합 검토 보고서 원문이 기록 뒤 바뀌었습니다(reportHash 다름)' }
# 보고서 원문은 저장소 밖 기록과도 같아야 한다 — 검토 세션의 보조 에이전트 기록(.jsonl)에서 SubagentHandback으로 돌려준 글. 그 기록이 실제 검토 기록의
# 꼴인지(이 저장소 세션 폴더 자리, 같은 보조 에이전트 줄, 고정 지시문 읽기, 머리 지문 = 검토 중 gate-hashes 결과, 상위 세션에 그 보조 에이전트)도 본다 —
# 이 컴퓨터의 파일은 고쳐 쓸 수 있어 막는 것이 아니라 위조 비용을 올린다(tools\report-source.js)
if (-not $overfit.reportSource) { Stop-Release '과적합 검토 기록에 보고서 원문의 저장소 밖 출처(reportSource — 검토 보조 에이전트 기록 .jsonl)가 없습니다' }
if (-not (Test-Path -LiteralPath $overfit.reportSource)) { Stop-Release "과적합 검토 보고서 원문 출처($($overfit.reportSource))가 없습니다" }
$source = (& node (Join-Path $root 'tools\report-source.js') $overfit.reportSource $root) | Out-String | ConvertFrom-Json
if (-not $source.ok) { Stop-Release "과적합 검토 보고서 원문 출처가 검토 기록의 꼴이 아닙니다: $(@($source.problems) -join '; ')" }
if ($source.sha -ne $overfit.reportHash) { Stop-Release '과적합 검토 보고서 원문이 저장소 밖 출처(검토 보조 에이전트가 돌려준 글)와 다릅니다' }
# 기록의 지문은 작성자가 적는다 — 검토자가 잰 지문과 같아야 한다. 검토자는 보고서 맨 앞(첫 지적 줄 전)에 「검토 시작 지문:」「검토 끝 지문:」 두 줄을
# 한 번씩 적고(지시문), 관문은 그 두 줄에서만 읽어 시작 = 끝 = 기록을 본다. 보고서 어디든 지문 글자만 있으면 통과시키면 검토 뒤 고치고 지문을 덧붙여도
# 지나갔다
$headLines = Read-ReportHead $reportPath
if ($headLines.late) { Stop-Release "과적합 검토 보고서의 지문 줄($($headLines.late))이 첫 지적 줄 뒤에 있습니다 — 보고서 맨 앞 줄에서만 읽습니다" }
if ($headLines.start.Count -ne 1 -or $headLines.end.Count -ne 1 -or $headLines.base.Count -gt 1) { Stop-Release "과적합 검토 보고서 맨 앞에 「검토 시작 지문」「검토 끝 지문」 줄이 한 번씩(「검토 바탕 지문」은 많아야 한 번) 있어야 합니다(시작 $($headLines.start.Count)개, 끝 $($headLines.end.Count)개, 바탕 $($headLines.base.Count)개)" }
$head = $headLines.start[0]; $tail = $headLines.end[0]
foreach ($key in 'contentHash', 'testsHash', 'harnessHash', 'promptHash') {
  if (-not $head[$key] -or $head[$key] -ne $tail[$key]) { Stop-Release "과적합 검토 보고서의 시작·끝 지문($key)이 없거나 다릅니다 — 검토 중에 바뀐 판입니다" }
}
foreach ($key in 'contentHash', 'promptHash', 'harnessHash') {
  if ([string]$overfit.$key -ne $head[$key]) { Stop-Release "과적합 검토 기록의 $key가 검토자가 잰 지문과 다릅니다 — 검토자가 본 판이어야 합니다(검토 뒤 고쳤으면 다시 검토)" }
}
$recorded = @(Get-Items $overfit.findings | ForEach-Object { $_.id })
$parsedReport = Read-ReportFindings $reportPath
$reported = @(Get-Items $parsedReport.ids); $severity = $parsedReport.severity
if (-not $reported.Count -and @(Get-Items $overfit.findings).Count) { Stop-Release '과적합 검토 보고서 원문에 지적 줄(id: …)이 없습니다 — 지시문의 보고 형식대로 받은 원문인지 확인하세요' }
$dropped = @($reported | Where-Object { $recorded -notcontains $_ })
if ($dropped.Count) { Stop-Release "과적합 검토 보고서의 지적이 기록에 없습니다($($dropped -join ', '))" }
foreach ($finding in @(Get-Items $overfit.findings)) {
  $label = "과적합 지적 $($finding.id)"
  if ($finding.status -ne 'fixed' -and $severity[$finding.id] -eq 'high' -and (-not $finding.quote -or -not $finding.question)) { Stop-Release "$label`: high 지적을 고침(fixed) 말고 다른 상태로 닫으려면 사용자 원문(quote)·그때 물은 글(question)이 필요합니다" }
  switch ($finding.status) {
    'fixed' { if (-not (& $passedTest $finding.test)) { Stop-Release "$label`: 고쳤다는데 확인 시험($($finding.test))이 이번 전체 시험에서 통과하지 않았습니다" } }
    { $_ -in 'hardening', 'wontfix', 'not-a-bug' } { if (-not $finding.reason) { Stop-Release "$label`: $($finding.status)인데 이유(reason)가 없습니다" } }
    default { Stop-Release "$label`: 처리되지 않았습니다(status=$($finding.status))" }
  }
}
# 모든 회차 보고서 원문(release\overfit-report-<버전>*.md): 중간 회차 지적은 review-<버전>.json에서 처리한다. 회차마다 보고서 원문이 처리 기록에
# 지문과 함께 묶이고(review의 reports {report, reportHash} 또는 위 overfit-review의 report), 그 지적 줄이 모두 두 기록 중 하나에 있고, high 규칙이
# 회차와 상관없이 같아야 한다 — 중간 회차 지적을 빼거나 high를 hardening으로 닫거나 원문을 고치는 길을 막는다(과적합 검토 5차).
$boundReports = @{ ($overfit.report -replace '\\', '/') = $true }
foreach ($entry in @(Get-Items $review.reports)) {
  if (-not $entry.report -or -not $entry.reportHash) { Stop-Release '검토 기록의 보고서 묶음(reports)에 report·reportHash가 없습니다' }
  $at = Join-Path $root ($entry.report -replace '/', '\')
  if (-not (Test-Path $at)) { Stop-Release "검토 기록이 묶은 보고서 원문($($entry.report))이 없습니다" }
  if ($entry.reportHash -ne (Get-FileHash -Algorithm SHA256 $at).Hash.ToLower()) { Stop-Release "보고서 원문($($entry.report))이 기록 뒤 바뀌었습니다(reportHash 다름)" }
  $boundReports[($entry.report -replace '\\', '/')] = $true
}
$everyFinding = @(Get-Items $review.findings) + @(Get-Items $overfit.findings)
foreach ($file in @(Get-ChildItem (Join-Path $root 'release') -Filter "overfit-report-$($manifest.version)*.md" -File)) {
  $rel = "release/$($file.Name)"
  if (-not $boundReports.ContainsKey($rel)) { Stop-Release "과적합 검토 보고서($rel)가 처리 기록에 묶이지 않았습니다 — review-$($manifest.version).json의 reports에 report·reportHash로 넣으세요" }
  $parsed = Read-ReportFindings $file.FullName
  foreach ($id in @(Get-Items $parsed.ids)) {
    $owners = @($everyFinding | Where-Object { $_.id -eq $id })
    if (-not $owners.Count) { Stop-Release "보고서($rel)의 지적($id)이 처리 기록에 없습니다" }
    if ($parsed.severity[$id] -eq 'high' -and @($owners | Where-Object { $_.status -ne 'fixed' -and (-not $_.quote -or -not $_.question) }).Count) { Stop-Release "보고서($rel)의 high 지적($id)을 고침(fixed) 말고 다른 상태로 닫으려면 사용자 원문(quote)·그때 물은 글(question)이 필요합니다" }
  }
}
# 회차 사슬: 지시문은 앞 회차가 끝까지 본 판(바탕 판) 이후 바뀐 곳만 보게 한다(5분 검토). 그 사이 바뀐 것이 검토 없이 빠지지 않게, 마지막 회차부터 바탕 판을
# 거슬러 올라가 직전 출시판과의 전체 차이를 본 회차(바탕 줄 없이 예전 지시문으로 한 회차, 또는 바탕 = 직전 출시판)에 닿아야 한다. 바탕 판은 묶인 다른
# 회차 보고서의 끝 지문이어야 하고 그 회차는 시작 = 끝이어야 한다(검토 도중 바뀐 판은 끝까지 본 판이 아님)
$heads = @{}
foreach ($rel in @($boundReports.Keys)) { $heads[$rel] = Read-ReportHead (Join-Path $root ($rel -replace '/', '\')) }
$sameHead = { param($h) $h -and -not $h.late -and $h.start.Count -eq 1 -and $h.end.Count -eq 1 -and $h.base.Count -le 1 -and
  @('contentHash', 'testsHash', 'harnessHash', 'promptHash' | Where-Object { -not $h.start[0][$_] -or $h.start[0][$_] -ne $h.end[0][$_] }).Count -eq 0 }
$at = ($overfit.report -replace '\\', '/'); $walked = @{}
while ($true) {
  $walked[$at] = $true
  $h = $heads[$at]
  if (-not $h.base.Count) {
    if ($h.start[0].promptHash -eq $promptHash) { Stop-Release "과적합 검토 보고서($at)에 「검토 바탕 지문」 줄이 없습니다 — 지금 지시문은 바탕 판(앞 회차가 끝까지 본 판)을 적게 합니다" }
    break
  }
  $base = $h.base[0]
  if (-not $base.contentHash -or -not $base.testsHash -or -not $base.harnessHash) { Stop-Release "과적합 검토 보고서($at)의 「검토 바탕 지문」에 contentHash·testsHash·harnessHash가 다 있어야 합니다" }
  if ($base.contentHash -eq $changes.baseContentHash) { break }
  $prev = @($heads.Keys | Where-Object { -not $walked[$_] -and (& $sameHead $heads[$_]) } | Where-Object {
    $end = $heads[$_].end[0]; $end.contentHash -eq $base.contentHash -and $end.testsHash -eq $base.testsHash -and $end.harnessHash -eq $base.harnessHash })
  if (-not $prev.Count) { Stop-Release "과적합 검토 보고서($at)의 바탕 판이 묶인 앞 회차 검토가 끝까지 본 판이 아닙니다 — 그 사이 바뀐 것이 검토 없이 빠집니다(바탕 판을 앞 회차 끝 판으로 다시 검토하세요)" }
  $at = $prev[0]
}
# 알고 있는 결함을 안 고친 채(wontfix) 내지 않는다 — 그 결함을 사용자가 알고 받아들인 원문(quote)·그때 물은 글(question)이 결함마다 따로 있어야 한다.
# 정책 한 줄(검토에 시간이 든다 등)로 여러 결함을 한꺼번에 남기면 막는다
$wontfix = @($everyFinding | Where-Object { $_.status -eq 'wontfix' })
foreach ($finding in $wontfix) {
  if (-not $finding.quote -or -not $finding.question) { Stop-Release "지적 $($finding.id): 알고 있는 결함을 안 고침(wontfix)으로 닫으려면 그 결함을 사용자가 알고 받아들인 원문(quote)·물은 글(question)이 있어야 합니다 — 고치세요" }
}
$shared = @($wontfix | Group-Object { "$($_.quote)`n$($_.question)" } | Where-Object { $_.Count -gt 1 })
if ($shared.Count) { Stop-Release "여러 지적을 같은 사용자 답 하나로 안 고침 처리했습니다($(@($shared | ForEach-Object { @($_.Group | ForEach-Object { $_.id }) -join '·' }) -join ', ')) — 결함마다 고치거나 따로 물으세요" }
# 6) release\base-run.json — 고치기 전 판(직전 출시판) 실행 기록. 고침(changes fix)·고쳤다는 검토 지적(fixed)의 확인 시험은 그 판에서 통과하지
#    않아야 한다(그 고침을 확인하는 시험인지). 사람이 적은 failsBefore 글만으로는 막지 못했다(과적합 검토 3차). 기록은 실행기가 남긴다.
#    failCheck(확인 이름)를 적은 항목은 그 확인이 고치기 전에 실패했어야 한다(시험 안 다른 확인의 실패로 지나가지 않게). 이번 판 안에서 생긴 회귀
#    (regression)는 직전 출시판에서 통과하므로, 고치기 전 개발판 기록(release\dev-base-run.json의 devBase 지문 판)에서 failCheck가 실패했어야 한다
#    (과적합 검토 6차 — 회귀 지적의 근거가 상관없는 확인의 1.3.1 실패였음).
$basePath = Join-Path $root 'release\base-run.json'
$baseRun = if (Test-Path $basePath) { Get-Content -Raw -Encoding UTF8 $basePath | ConvertFrom-Json } else { $null }
$devPath = Join-Path $root 'release\dev-base-run.json'
$devRun = if (Test-Path $devPath) { Get-Content -Raw -Encoding UTF8 $devPath | ConvertFrom-Json } else { $null }
$itemOf = { param($label, $x) @{ label = $label; test = $x.test; failCheck = $x.failCheck; regression = [bool]$x.regression; devBase = $x.devBase } }
$mustFailBefore = @()
$mustFailBefore += @($changes.changes | Where-Object { $_.origin -eq 'fix' } | ForEach-Object { & $itemOf "바뀐 점 $($_.id)" $_ })
$mustFailBefore += @($review.findings | Where-Object { $_.status -eq 'fixed' } | ForEach-Object { & $itemOf "지적 $($_.id)" $_ })
$mustFailBefore += @($overfit.findings | Where-Object { $_.status -eq 'fixed' } | ForEach-Object { & $itemOf "과적합 지적 $($_.id)" $_ })
if ($mustFailBefore.Count) {
  if (-not $baseRun) { Stop-Release '고치기 전 판 실행 기록이 없습니다(release\base-run.json — node tests/run.js --ext=<직전 출시판 폴더> --base-record)' }
  if (-not $changes.baseContentHash -or $baseRun.baseContentHash -ne $changes.baseContentHash) { Stop-Release '고치기 전 판 실행 기록이 바뀐 점 기록의 기준 판(baseContentHash)과 다릅니다' }
  foreach ($item in $mustFailBefore) {
    if ($item.regression) {
      if (-not $item.devBase -or -not $item.failCheck) { Stop-Release "$($item.label)`: 회귀(regression)는 고치기 전 개발판 지문(devBase)과 실패해야 할 확인(failCheck)이 필요합니다" }
      if ($item.devBase -eq $changes.baseContentHash) { Stop-Release "$($item.label)`: 회귀의 고치기 전 판(devBase)이 직전 출시판과 같습니다" }
      $base = if ($devRun) { $devRun.bases.PSObject.Properties[$item.devBase] } else { $null }
      if (-not $base) { Stop-Release "$($item.label)`: 고치기 전 개발판($($item.devBase)) 실행 기록이 없습니다(node tests/run.js --ext=<그 판 폴더> --dev-base-record)" }
      $entry = $base.Value.cases.PSObject.Properties[$item.test]
      $where = '고치기 전 개발판'
    } else {
      $entry = $baseRun.cases.PSObject.Properties[$item.test]
      $where = '고치기 전 판'
    }
    if (-not $entry) { Stop-Release "$($item.label)`: 확인 시험($($item.test))을 $where 실행 기록에서 찾지 못했습니다" }
    if ($entry.Value.status -eq 'CHANGED') { Stop-Release "$($item.label)`: $where 실행 도중 시험 파일이 바뀌어 그 기록은 무효입니다 — 다시 돌리세요" }
    if ($entry.Value.fileHash -ne (Get-ListHash @($entry.Value.file))) { Stop-Release "$($item.label)`: $where 실행 뒤 시험($($item.test)) 파일이 바뀌었습니다 — 다시 돌리세요" }
    if ([string]$entry.Value.libHash -ne [string](Get-LibHash $entry.Value.file)) { Stop-Release "$($item.label)`: $where 실행 뒤 시험($($item.test))이 쓰는 시험 도구(tests/lib)가 바뀌었거나 기록에 도구 지문(libHash)이 없습니다 — 다시 돌리세요" }
    if ($item.failCheck) {
      $check = @($entry.Value.checks | Where-Object { $_.label -eq $item.failCheck })
      if (-not $check.Count) { Stop-Release "$($item.label)`: $where 기록에 확인($($item.failCheck))이 없습니다" }
      if (@($check | Where-Object { $_.ok }).Count) { Stop-Release "$($item.label)`: 확인($($item.failCheck))이 $where 기록에서도 통과합니다 — 그 고침을 확인하는 확인이 아닙니다" }
    } elseif ($entry.Value.status -eq 'PASS') { Stop-Release "$($item.label)`: 확인 시험($($item.test))이 $where 기록에서도 통과합니다 — 그 고침을 확인하는 시험이 아닙니다" }
  }
}
# 검사 도중 시험 파일을 불러오므로(Get-LibHash) 그 사이 확장 파일이 바뀌지 않았는지 zip 직전에 다시 잰다
if ((Get-ListHash $files) -ne $contentHash) { Stop-Release '관문 검사 도중 확장 파일이 바뀌었습니다 — 다시 돌리세요' }
Write-Output "출시 관문 통과: 시험 $(@(Get-Items $run.cases).Count)종 모두 통과($($run.at)), 검토 지적 $(@(Get-Items $review.findings).Count)개 처리됨, 바뀐 점 $(@(Get-Items $changes.changes).Count)개 출처 확인, 미확인 경로 $(@(Get-Items $risks.risks).Count)개 닫힘, 과적합 지적 $(@(Get-Items $overfit.findings).Count)개 처리됨, 마지막 검토 $($source.minutes)분"

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist "entry-vector-rig-$($manifest.version).zip"
if (Test-Path $out) { Remove-Item $out -Confirm:$false }
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
  foreach ($name in $files) {
    $source = Join-Path $root ($name -replace '/', '\')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source, $name, 'Optimal') | Out-Null
  }
} finally { $zip.Dispose() }
Write-Output "$out ($($files.Count)개 파일)"
