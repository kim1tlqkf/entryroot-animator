# 출시 관문(pack.ps1) 자기 점검: 임시 폴더에 확장·기록을 복사해 경우마다 기록을 망가뜨려 보고, 관문이 막아야 할 때 막는지(zip을 안 만드는지),
# 맞을 때만 zip을 만드는지 실제로 돌려 본다. 저장소 파일은 건드리지 않는다.
# 쓰는 법: powershell -ExecutionPolicy Bypass -File tools\release-gate-selftest.ps1   (먼저 node tests/run.js 로 전체 시험 기록이 있어야 함)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'manifest.json') | ConvertFrom-Json
$version = $manifest.version
$failures = 0

function New-Copy {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("evr-gate-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory $dir | Out-Null
  foreach ($name in 'pack.ps1', 'manifest.json', 'rig.js', 'rig.css', 'LICENSE') { Copy-Item (Join-Path $repo $name) $dir }
  foreach ($name in 'vendor', 'icons', 'release', 'tools') { Copy-Item -Recurse (Join-Path $repo $name) (Join-Path $dir $name) }
  # 시험 지문(testsHash)·점검 틀 지문(harnessHash)을 관문이 다시 재므로 시험(실행 결과 폴더 out 빼고)도 복사한다
  New-Item -ItemType Directory (Join-Path $dir 'tests') | Out-Null
  Copy-Item (Join-Path $repo 'tests\run.js') (Join-Path $dir 'tests')
  foreach ($name in 'lib', 'cases', 'real-server', 'fixtures', 'fixture-makers', 'known-limits') { Copy-Item -Recurse (Join-Path $repo "tests\$name") (Join-Path $dir "tests\$name") }
  # 복사본의 미확인 경로는 닫아 둔다 — 다른 경우들이 각자의 이유로 막히는지 보려고(미확인 경로 경우는 아래에서 다시 연다)
  Edit-Json (Join-Path $dir 'release\open-risks.json') { param($j) foreach ($r in @($j.risks)) { $r.status = 'accepted'; $r | Add-Member -Force quote '자기 점검'; $r | Add-Member -Force consequence '자기 점검' } }
  # 과적합 기록의 원문 출처(검토 보조 에이전트 기록)는 관문이 집 폴더의 Claude 세션 기록 자리(그 아래 <저장소 이름표>\<세션>\subagents)를 본다 — 사본 안 가짜 집에
  # 이 사본 이름표로 같은 기록을 옮겨 두고(상위 세션 기록은 그 보조 에이전트 이름만 든 작은 파일), 관문은 그 집으로 돌린다(Test-Case)
  $overfitPath = Join-Path $dir "release\overfit-review-$version.json"
  if (Test-Path $overfitPath) {
    $real = [string](Get-Content -Raw -Encoding UTF8 $overfitPath | ConvertFrom-Json).reportSource
    if ($real -and (Test-Path -LiteralPath $real)) {
      $agent = Split-Path -Leaf $real; $session = Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $real))
      $place = & $sourcePlace $dir $session
      Copy-Item -LiteralPath $real (Join-Path $place $agent)
      & $noteParent $place ($agent -replace '^agent-', '' -replace '\.jsonl$', '')
      Edit-Json $overfitPath { param($j) $j.reportSource = (Join-Path $place $agent) }
    }
  }
  return $dir
}
# 사본의 가짜 집 아래 이 사본 이름표·세션 폴더(subagents)를 만들고 상위 세션 기록(보조 에이전트 이름이 들어갈 파일)을 둔다
$sourcePlace = { param($dir, $session)
  $slug = ([System.IO.Path]::GetFullPath($dir)).TrimEnd('\') -replace '[^A-Za-z0-9]', '-'
  $base = [System.IO.Path]::Combine($dir, 'selftest-home', '.claude', 'projects', $slug)
  $place = Join-Path $base "$session\subagents"
  New-Item -ItemType Directory -Force $place | Out-Null
  $parent = Join-Path $base "$session.jsonl"
  return $place }
$noteParent = { param($place, $id) Add-Content -Encoding UTF8 ((Split-Path -Parent $place) + '.jsonl') ('{"type":"assistant","toolUseResult":{"agentId":"' + $id + '"}}') }
function Edit-Json($path, [scriptblock]$change) {
  $data = Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json
  & $change $data
  $data | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 $path
}
# because: 막혀야 하는 경우의 막힌 이유(정규식) — 다른 까닭으로 먼저 막혀 그 검사에 닿지 않은 채 통과로 세지 않게
function Test-Case($label, [bool]$shouldPass, [scriptblock]$prepare, [string]$because = '') {
  $dir = New-Copy
  try {
    & $prepare $dir
    $zip = Join-Path $dir "dist\entry-vector-rig-$version.zip"
    # 막힌 관문은 오류(stderr)를 내므로, 이 호출 동안만 오류로 멈추지 않게 한다(PowerShell 5.1은 stderr를 NativeCommandError로 바꿈)
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    # 집을 바꾸면 PowerShell이 모듈 분석 캐시 자리를 못 찾아 지금 폴더(저장소)에 써서, 캐시 자리도 사본 안으로 둔다
    $home0 = $env:USERPROFILE; $cache0 = $env:PSModuleAnalysisCachePath
    $env:USERPROFILE = Join-Path $dir 'selftest-home'; $env:PSModuleAnalysisCachePath = Join-Path $dir 'selftest-home\ModuleAnalysisCache'
    try { $output = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'pack.ps1') 2>&1 | Out-String }
    finally { $ErrorActionPreference = $previous; $env:USERPROFILE = $home0; $env:PSModuleAnalysisCachePath = $cache0 }
    $made = Test-Path $zip
    $ok = ($made -eq $shouldPass) -and ($shouldPass -or -not $because -or $output -match $because)
    $verdict = if ($ok) { 'PASS' } else { 'FAIL' }
    $expect = if ($shouldPass) { 'zip 만듦' } else { '막음' }
    # 관문 알림 줄이 없으면(관문이 알림 없이 멈춤) 첫 출력 줄을 보인다
    $reason = @($output -split "`n" | Where-Object { $_ -match '출시 관문' } | Select-Object -First 1) -join ''
    if (-not $reason.Trim()) { $reason = '알림 없이 끝남: ' + (@($output -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1) -join '') }
    Write-Output ("{0}  {1} (기대: {2}, 실제: {3}) {4}" -f $verdict, $label, $expect, $(if ($made) { 'zip 만듦' } else { '막음' }), $reason.Trim())
    if (-not $ok) { $script:failures++ }
  } finally { Remove-Item -Recurse -Force $dir -Confirm:$false }
}

# 공개되는 관문 설명(release\README.md)의 지문 범위 줄이 tools\gate-hashes.js의 HARNESS_SCOPE와 같은지(과적합 검토 5차 — 설명과 실제 관문이 달랐음)
$scopeLine = Get-Content -Encoding UTF8 (Join-Path $repo 'release\README.md') | Where-Object { $_ -match '지문 범위\(harnessHash\):' } | Select-Object -First 1
$documented = @([regex]::Matches([string]$scopeLine, '`([^`]+)`') | ForEach-Object { $_.Groups[1].Value })
$actual = @((& node (Join-Path $repo 'tools\gate-hashes.js') --scope) | Out-String | ConvertFrom-Json | ForEach-Object { $_ })
if (-not $scopeLine -or (Compare-Object $documented $actual)) { Write-Output "FAIL  release\README.md 지문 범위 줄이 HARNESS_SCOPE와 다름(설명: $($documented -join ' '), 실제: $($actual -join ' '))"; $failures++ }
else { Write-Output 'PASS  release\README.md 지문 범위 줄 = HARNESS_SCOPE' }
# 시험 도구(tests/lib) 찾기: require 꼴이 달라도(path.join·../lib·확장자 없음) 찾고, 못 찾는 글자는 막는지(tools\gate-hashes.js --self-test)
$libLines = @(& node (Join-Path $repo 'tools\gate-hashes.js') --self-test)
if ($LASTEXITCODE -ne 0 -or -not $libLines.Count -or @($libLines | Where-Object { $_ -notmatch '^PASS' }).Count) { Write-Output "FAIL  시험 도구 찾기 자기 점검: $($libLines -join ' / ')"; $failures++ }
else { Write-Output "PASS  시험 도구 찾기 자기 점검($($libLines.Count)가지)" }

Test-Case '기록 모두 맞음' $true { param($d) }
Test-Case '독립 검토 기록 없음(1.2.0 때처럼)' $false { param($d) Remove-Item (Join-Path $d "release\review-$version.json") -Confirm:$false }
Test-Case '전체 시험 기록 없음' $false { param($d) Remove-Item (Join-Path $d 'release\last-full-run.json') -Confirm:$false }
Test-Case '시험 뒤 rig.js가 바뀜' $false { param($d) Add-Content -Encoding UTF8 (Join-Path $d 'rig.js') '// 시험 뒤에 고친 줄' }
Test-Case '시험에 실패한 것이 있음' $false { param($d) Edit-Json (Join-Path $d 'release\last-full-run.json') { param($j) $j.allPassed = $false } }
Test-Case '처리 안 된 지적(open)이 있음' $false { param($d) Edit-Json (Join-Path $d "release\review-$version.json") { param($j) $j.findings[0].status = 'open' } }
Test-Case '고쳤다는데 확인 시험이 이번 기록에 없음' $false { param($d) Edit-Json (Join-Path $d "release\review-$version.json") { param($j) $j.findings[0].test = 'no-such-test' } }
Test-Case '안 고친 지적에 이유가 없음' $false { param($d) Edit-Json (Join-Path $d "release\review-$version.json") { param($j) ($j.findings | Where-Object { $_.status -eq 'wontfix' } | Select-Object -First 1).reason = '' } }
Test-Case '검토 기록 버전이 다름' $false { param($d) Edit-Json (Join-Path $d "release\review-$version.json") { param($j) $j.version = '0.0.0' } }
# 바뀐 점 출처 기록: 1.2.1 '작품 저장 확인'처럼 원인 미확인 짐작 기능을 막는지
$changesFile = "release\changes-$version.json"
Test-Case '바뀐 점 출처 기록 없음' $false { param($d) Remove-Item (Join-Path $d $changesFile) -Confirm:$false }
Test-Case '원인을 재현 못 한 고침(1.2.1 작품 저장 확인처럼)' $false { param($d) Edit-Json (Join-Path $d $changesFile) { param($j) ($j.changes | Where-Object { $_.origin -eq 'fix' } | Select-Object -First 1).reproduced = $false } }
# 구현 교체(superseded): 고친 지적 하나를 바꿔 넣고 한 칸씩 빼 본다 — 원문·물은 글·이유·바꾼 요청이 다 있고 바꾼 요청이 request면 지나가고, 하나라도
# 빠지거나 바꾼 요청이 request가 아니면 막는다
$supersede = { param($d, [scriptblock]$spoil)
  $requestId = @((Get-Content -Raw -Encoding UTF8 (Join-Path $d $changesFile) | ConvertFrom-Json).changes | Where-Object { $_.origin -eq 'request' } | Select-Object -First 1).id
  $fixId = @((Get-Content -Raw -Encoding UTF8 (Join-Path $d $changesFile) | ConvertFrom-Json).changes | Where-Object { $_.origin -ne 'request' } | Select-Object -First 1).id
  Edit-Json (Join-Path $d "release\review-$version.json") { param($j) $f = $j.findings | Where-Object { $_.status -eq 'fixed' } | Select-Object -First 1
    $f.status = 'superseded'; $f | Add-Member -Force quote '자기 점검 원문'; $f | Add-Member -Force question '자기 점검 질문'; $f | Add-Member -Force reason '자기 점검 이유'; $f | Add-Member -Force replacedBy $requestId
    $f.PSObject.Properties.Remove('test')
    if ($spoil) { & $spoil $f $fixId } } }
Test-Case '구현 교체 지적 + 원문·물은 글·이유·바꾼 요청(request)' $true { param($d) & $supersede $d $null }
Test-Case '구현 교체 지적에 사용자 원문이 없음' $false { param($d) & $supersede $d { param($f) $f.quote = '' } } '구현 교체'
Test-Case '구현 교체 지적에 물은 글이 없음' $false { param($d) & $supersede $d { param($f) $f.question = '' } } '구현 교체'
Test-Case '구현 교체 지적의 바꾼 요청이 request가 아님' $false { param($d) & $supersede $d { param($f, $fixId) $f.replacedBy = $fixId } } '바꾼 요청'
Test-Case '구현 교체 지적의 바꾼 요청이 기록에 없음' $false { param($d) & $supersede $d { param($f) $f.replacedBy = 'no-such-change' } } '바꾼 요청'
Test-Case '구현 교체 지적에 적은 확인 시험이 이번 기록에 없음' $false { param($d) & $supersede $d { param($f) $f | Add-Member -Force test 'no-such-test' } } '확인 시험'
# 그 판 기록에 그 종류(요청·예방·뺀 것) 항목이 없으면 맞는 항목을 하나 만들어 넣고 한 칸만 망가뜨린다 — 판마다 규칙을 늘 점검하게
$passedForChange = @((Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'release\last-full-run.json') | ConvertFrom-Json).cases | Where-Object { $_.status -eq 'PASS' } | Select-Object -First 1).name
$changeOf = { param($j, $origin)
  $c = $j.changes | Where-Object { $_.origin -eq $origin } | Select-Object -First 1
  if (-not $c) {
    $c = [pscustomobject]@{ id = "selftest-$origin"; summary = '자기 점검'; origin = $origin }
    switch ($origin) {
      'request' { $c | Add-Member quote '원문'; $c | Add-Member test $passedForChange }
      'hardening' { $c | Add-Member noNewBehavior $true; $c | Add-Member reason '이유' }
      'removal' { $c | Add-Member quote '원문'; $c | Add-Member reason '이유' }
    }
    $j.changes = @($j.changes) + $c
  }
  return $c }
Test-Case '내 선택지에 대한 답인데 전제가 없음' $false { param($d) Edit-Json (Join-Path $d $changesFile) { param($j) $c = & $changeOf $j 'request'; $c | Add-Member -Force fromOption $true; $c | Add-Member -Force premise '' } }
Test-Case '선택지 사실 전제의 시험이 이번 기록에 없음' $false { param($d) Edit-Json (Join-Path $d $changesFile) { param($j) $c = & $changeOf $j 'request'; $c | Add-Member -Force fromOption $true; $c | Add-Member -Force premise 'no-such-test' } }
Test-Case '새 동작이 있는데 예방이라고 함' $false { param($d) Edit-Json (Join-Path $d $changesFile) { param($j) $c = & $changeOf $j 'hardening'; $c | Add-Member -Force noNewBehavior $false } }
Test-Case '요청인데 사용자 원문이 없음' $false { param($d) Edit-Json (Join-Path $d $changesFile) { param($j) $c = & $changeOf $j 'request'; $c | Add-Member -Force quote '' } }
Test-Case '뺀 것인데 이유가 없음' $false { param($d) Edit-Json (Join-Path $d $changesFile) { param($j) $c = & $changeOf $j 'removal'; $c | Add-Member -Force reason '' } }

# 시험 폴더와 기록의 시험 파일 목록: 시험을 새로 넣고 전체 시험을 다시 안 돌린 경우를 막는지(사본에는 저장소 시험이 그대로 있음)
Test-Case '기록에 없는 새 시험 파일이 있음(넣고 다시 안 돌림)' $false { param($d) Set-Content -Encoding UTF8 (Join-Path $d 'tests\cases\new-switch-test.js') '// 자기 점검용 빈 시험' }
Test-Case '기록에 시험 파일 목록이 없음(예전 기록)' $false { param($d) Edit-Json (Join-Path $d 'release\last-full-run.json') { param($j) $j.PSObject.Properties.Remove('caseFiles') } }
# 시험·도구 지문(과적합 검토 지적): 전체 시험 뒤 시험을 약하게 고치거나, 과적합 검토 뒤 도구·관문을 고친 것을 막는지
$someCase = (Get-ChildItem (Join-Path $repo 'tests\cases') -Filter '*.js' -File | Select-Object -First 1).Name
Test-Case '전체 시험 뒤 시험 파일을 고침(testsHash 다름)' $false { param($d) Add-Content -Encoding UTF8 (Join-Path $d "tests\cases\$someCase") '// 시험 뒤에 약하게 고친 줄' }
Test-Case '과적합 검토 뒤 도구를 고침(harnessHash 다름)' $false { param($d) Add-Content -Encoding UTF8 (Join-Path $d 'tools\public-copy-check.js') '// 검토 뒤에 고친 줄' }

# 미확인 경로 목록: 시험이 닿지 않는 사용자 경로가 남았는데 출시하는 것을 막는지
$risksFile = 'release\open-risks.json'
$firstPass = @((Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'release\last-full-run.json') | ConvertFrom-Json).cases | Where-Object { $_.status -eq 'PASS' } | Select-Object -First 1).name
Test-Case '미확인 경로 목록 없음' $false { param($d) Remove-Item (Join-Path $d $risksFile) -Confirm:$false }
Test-Case '미확인 경로가 open으로 남음' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $j.risks[0].status = 'open' } }
Test-Case '실제 서버 길을 가짜 서버 시험(tested)으로 닫음' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'tested'; $r | Add-Member -Force realServer $true; $r | Add-Member -Force test $firstPass } }
Test-Case 'tested인데 시험이 이번 기록에 없음' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'tested'; $r | Add-Member -Force realServer $false; $r | Add-Member -Force test 'no-such-test' } }
Test-Case 'tested + 이번 전체 시험에서 통과한 시험' $true { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'tested'; $r | Add-Member -Force realServer $false; $r | Add-Member -Force test $firstPass } }
Test-Case 'verified인데 증거가 없음' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'verified'; $r | Add-Member -Force evidence '' } }
Test-Case 'accepted인데 사용자 원문이 없음' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $j.risks[0].quote = '' } }
# 미확인 경로를 닫는 근거(과적합 검토 지적): 위임 답을 확인으로 쓰거나 탐침 없이 실제 서버 확인이라고 하는 것을 막는지
Test-Case 'verified인데 보여 준 질문 글이 없음(위임 답을 확인으로 씀)' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'verified'; $r | Add-Member -Force evidence '증거'; $r | Add-Member -Force quote '다 해줘'; $r.PSObject.Properties.Remove('question') } }
Test-Case 'verified + 보여 준 질문 글 있음' $true { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'verified'; $r | Add-Member -Force evidence '증거'; $r | Add-Member -Force quote '확인함'; $r | Add-Member -Force question '이 결과로 닫을까요?' } }
# PowerShell 5.1은 없는 칸을 @()로 감싸면 $null 하나짜리 목록이라, 칸이 아예 없는 기록도 빈 목록과 같이 막는지(관문 Get-Items)
Test-Case 'probed인데 탐침 칸이 아예 없음' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'probed'; $r | Add-Member -Force evidence '증거'; $r.PSObject.Properties.Remove('probe') } } '탐침 파일\(probe\)이 없습니다'
Test-Case 'probed인데 탐침 파일이 저장소에 없음' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'probed'; $r | Add-Member -Force evidence '증거'; $r | Add-Member -Force probe @('tests/real-server/no-such-probe.js') } }
# 탐침은 실행기가 남긴 실행 기록에서 지금 판으로 PASS여야 한다(과적합 검토 2·3차): 기록 없음·실패·옛 판·탐침 뒤 고친 탐침 파일을 막는지
$probeFile = 'tests/real-server/probe-real-save-size.js'
$nowContent = ((& node (Join-Path $repo 'tools\gate-hashes.js')) | Out-String | ConvertFrom-Json).contentHash
$nowProbe = ((& node (Join-Path $repo 'tools\gate-hashes.js') --files $probeFile) | Out-String).Trim()
$probedRisk = { param($r) $r.status = 'probed'; $r | Add-Member -Force evidence '증거'; $r | Add-Member -Force probe @($probeFile) }
$probeRun = { param($d, $status, $content)
  $runs = [pscustomobject]@{}
  $runs | Add-Member -NotePropertyName $probeFile -NotePropertyValue ([pscustomobject]@{ contentHash = $content; fileHash = $nowProbe; status = $status; passed = 1; total = 1 })
  [pscustomobject]@{ runs = $runs } | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $d 'release\probe-runs.json') }
Test-Case 'probed + 지금 판 PASS 실행 기록' $true { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) & $probedRisk $j.risks[0] }; & $probeRun $d 'PASS' $nowContent }
Test-Case 'probed인데 탐침 실행 기록 없음(지문만 손으로 적음)' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) & $probedRisk $j.risks[0]; $j.risks[0] | Add-Member -Force contentHash $nowContent }; Remove-Item -ErrorAction SilentlyContinue (Join-Path $d 'release\probe-runs.json') -Confirm:$false }
Test-Case 'probed인데 실행 기록이 FAIL' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) & $probedRisk $j.risks[0] }; & $probeRun $d 'FAIL' $nowContent }
Test-Case 'probed인데 옛 판 실행 기록' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) & $probedRisk $j.risks[0] }; & $probeRun $d 'PASS' ('0' * 64) }
Test-Case 'probed 뒤 탐침 파일을 고침' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) & $probedRisk $j.risks[0] }; & $probeRun $d 'PASS' $nowContent; Add-Content -Encoding UTF8 (Join-Path $d ($probeFile -replace '/', '\')) '// 탐침 뒤에 고친 줄' }
Test-Case 'verified + 탐침인데 옛 판 실행 기록' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; & $probedRisk $r; $r.status = 'verified'; $r | Add-Member -Force quote '확인함'; $r | Add-Member -Force question '이 결과로 닫을까요?' }; & $probeRun $d 'PASS' ('0' * 64) }
# 새 검토를 받은 것처럼: 실제 검토 보조 에이전트 기록의 꼴(첫 지시 글이 고정 지시문을 가리킴, 지시문 Read, gate-hashes 실행 결과 = 보고서 머리 시작·끝
# 지문, 마지막에 SubagentHandback으로 사본 보고서 글)을 사본 가짜 집에 새로 두고 reportSource를 그것으로. noPrompt면 첫 글에 지시문이 없다
$newReview = { param($d, [switch]$noPrompt, [switch]$shell, [switch]$unread)
  $record = Get-Content -Raw -Encoding UTF8 (Join-Path $d "release\overfit-review-$version.json") | ConvertFrom-Json
  $text = [System.IO.File]::ReadAllText((Join-Path $d (([string]$record.report) -replace '/', '\')), (New-Object System.Text.UTF8Encoding $false))
  $head = @($text -split "`n" | Where-Object { $_ -match '검토 (시작|끝) 지문' })
  $id = 'aselftest' + [guid]::NewGuid().ToString('N').Substring(0, 8); $session = [guid]::NewGuid().ToString()
  $place = & $sourcePlace $d $session
  $line = { param($type, $content) [pscustomobject]@{ type = $type; isSidechain = $true; agentId = $id; message = [pscustomobject]@{ role = $type; content = $content } } | ConvertTo-Json -Depth 10 -Compress }
  $use = { param($tid, $name, $what) & $line 'assistant' @([pscustomobject]@{ type = 'tool_use'; id = $tid; name = $name; input = $what }) }
  $result = { param($tid, $out) & $line 'user' @([pscustomobject]@{ type = 'tool_result'; tool_use_id = $tid; content = $out }) }
  $first = if ($noPrompt) { '검토해 주세요.' } else { "고정 지시문 $(Join-Path $d 'release\overfit-review-prompt.md') 를 읽고 그대로 따르세요. 이번 검토 정보: …" }
  # 지시문 읽기·지문 재기: 기본은 Read·Bash, shell이면 PowerShell(Get-Content·node), unread면 지시문 파일을 가리켰지만 결과에 지시문 글이 없음
  $promptFile = Join-Path $d 'release\overfit-review-prompt.md'
  $promptText = if ($unread) { '(읽지 못함)' } else { [System.IO.File]::ReadAllText($promptFile, (New-Object System.Text.UTF8Encoding $false)) }
  $tool = if ($shell) { 'PowerShell' } else { 'Bash' }
  $readUse = if ($shell) { & $use 't1' 'PowerShell' ([pscustomobject]@{ command = "Get-Content -Raw -Encoding UTF8 '$promptFile'" }) } else { & $use 't1' 'Read' ([pscustomobject]@{ file_path = $promptFile }) }
  $rows = @(
    (& $line 'user' $first),
    $readUse, (& $result 't1' $promptText),
    (& $use 't2' $tool ([pscustomobject]@{ command = 'node tools/gate-hashes.js' })), (& $result 't2' ([string]$head[0])),
    (& $use 't3' $tool ([pscustomobject]@{ command = 'node tools/gate-hashes.js' })), (& $result 't3' ([string]$head[-1])),
    (& $use 't4' 'SubagentHandback' ([pscustomobject]@{ message = $text })))
  [System.IO.File]::WriteAllText((Join-Path $place "agent-$id.jsonl"), ($rows -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
  & $noteParent $place $id
  Edit-Json (Join-Path $d "release\overfit-review-$version.json") { param($j) $j | Add-Member -Force reportSource (Join-Path $place "agent-$id.jsonl") } }
# 시험 도구(tests/lib)를 고친 뒤 전체 시험·과적합 검토를 다시 한 것처럼 기록 지문을 맞춘다 — 그다음 검사(고치기 전 판·탐침 기록의 도구 지문)에 닿게
$rebind = { param($d)
  $now = (& node (Join-Path $d 'tools\gate-hashes.js')) | Out-String | ConvertFrom-Json
  Edit-Json (Join-Path $d 'release\last-full-run.json') { param($j) $j.testsHash = $now.testsHash }
  $record = Get-Content -Raw -Encoding UTF8 (Join-Path $d "release\overfit-review-$version.json") | ConvertFrom-Json
  $report = Join-Path $d (([string]$record.report) -replace '/', '\')
  [System.IO.File]::WriteAllText($report, (Get-Content -Raw -Encoding UTF8 $report).Replace([string]$record.harnessHash, $now.harnessHash), (New-Object System.Text.UTF8Encoding $false))
  $hash = (Get-FileHash -Algorithm SHA256 $report).Hash.ToLower()
  Edit-Json (Join-Path $d "release\overfit-review-$version.json") { param($j) $j.harnessHash = $now.harnessHash; $j.reportHash = $hash }
  & $newReview $d }
# 어느 도구가 고친 지적의 기록에 묶여 있는지는 판마다 다르다(그 도구를 쓰던 지적이 구현 교체로 닫히면 기록에서 빠짐) — 도구를 모두 고친다
$touchLib = { param($d) Get-ChildItem (Join-Path $d 'tests\lib') -Filter '*.js' -File | ForEach-Object { Add-Content -Encoding UTF8 $_.FullName '// 기록 뒤에 고친 줄' } }
# 탐침이 쓰는 시험 도구(tests/lib)도 기록에 묶인다: 도구 쓰는 탐침 + 지금 도구 지문은 통과, 기록 뒤 도구를 고치면 막힘
$libProbe = 'tests/real-server/probe-real-shape-flatten.js'
$libProbeRun = { param($d)
  $runs = [pscustomobject]@{}
  $file = ((& node (Join-Path $d 'tools\gate-hashes.js') --files $libProbe) | Out-String).Trim()
  $lib = ((& node (Join-Path $d 'tools\gate-hashes.js') --lib $libProbe) | Out-String).Trim()
  $runs | Add-Member -NotePropertyName $libProbe -NotePropertyValue ([pscustomobject]@{ contentHash = $nowContent; fileHash = $file; libHash = $lib; status = 'PASS'; passed = 1; total = 1 })
  [pscustomobject]@{ runs = $runs } | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $d 'release\probe-runs.json') }
$libProbeRisk = { param($r) $r.status = 'probed'; $r | Add-Member -Force evidence '증거'; $r | Add-Member -Force probe @($libProbe) }
Test-Case 'probed(시험 도구를 쓰는 탐침) + 지금 도구 지문' $true { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) & $libProbeRisk $j.risks[0] }; & $libProbeRun $d }
Test-Case 'probed 뒤 그 탐침이 쓰는 시험 도구(tests/lib)를 고침' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) & $libProbeRisk $j.risks[0] }; & $libProbeRun $d; & $touchLib $d; & $rebind $d } 'tests/lib'
# 알려진 한계 시험은 사용자가 받아들인 막힘 목록 항목이 있어야 한다(과적합 검토 3차). 시험 파일을 더하면 점검 틀 지문이 바뀌므로 사본의 과적합 기록 지문을 맞춘다.
$addLimit = { param($d)
  Set-Content -Encoding UTF8 (Join-Path $d 'tests\known-limits\selftest-limit.js') '// 자기 점검용 알려진 한계'
  $harness = ((& node (Join-Path $d 'tools\gate-hashes.js')) | Out-String | ConvertFrom-Json).harnessHash
  # 그 점검 틀로 검토받은 것처럼 보고서 머리의 시작·끝 지문 줄도 새 지문으로 바꾼다(관문이 그 두 줄과 기록을 견줌)
  $record = Get-Content -Raw -Encoding UTF8 (Join-Path $d "release\overfit-review-$version.json") | ConvertFrom-Json
  $report = Join-Path $d (([string]$record.report) -replace '/', '\')
  [System.IO.File]::WriteAllText($report, (Get-Content -Raw -Encoding UTF8 $report).Replace([string]$record.harnessHash, $harness), (New-Object System.Text.UTF8Encoding $false))
  $hash = (Get-FileHash -Algorithm SHA256 $report).Hash.ToLower()
  Edit-Json (Join-Path $d "release\overfit-review-$version.json") { param($j) $j.harnessHash = $harness; $j.reportHash = $hash }
  & $newReview $d }
Test-Case '알려진 한계 시험인데 막힘 목록 항목 없음' $false { param($d) & $addLimit $d }
Test-Case '알려진 한계 시험 + 받아들인 항목(원문·질문)' $true { param($d) & $addLimit $d; Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r.status = 'accepted'; $r | Add-Member -Force knownLimit 'tests/known-limits/selftest-limit.js'; $r | Add-Member -Force question '이 한계를 받아들일까요?' } }
Test-Case 'accepted 선택지 답인데 질문 글이 없음' $false { param($d) Edit-Json (Join-Path $d $risksFile) { param($j) $r = $j.risks[0]; $r | Add-Member -Force fromOption $true; $r.PSObject.Properties.Remove('question') } }

# 과적합 공격 검토: 다른 검토자가 고정 지시문으로 지금 확장 파일을 검토한 기록 없이 출시하는 것을 막는지
$overfitFile = "release\overfit-review-$version.json"
Test-Case '과적합 검토 기록 없음' $false { param($d) Remove-Item (Join-Path $d $overfitFile) -Confirm:$false }
Test-Case '과적합 검토 뒤 확장 파일이 바뀜(contentHash 다름)' $false { param($d) Edit-Json (Join-Path $d $overfitFile) { param($j) $j.contentHash = '0' * 64 } }
Test-Case '과적합 검토 지시문을 바꿈(promptHash 다름)' $false { param($d) Add-Content -Encoding UTF8 (Join-Path $d 'release\overfit-review-prompt.md') '- (범위를 줄인 줄)' }
Test-Case '과적합 검토에 확인한 곳 목록이 없음' $false { param($d) Edit-Json (Join-Path $d $overfitFile) { param($j) $j.checked = @() } }
Test-Case '과적합 검토에 확인한 곳 칸이 아예 없음' $false { param($d) Edit-Json (Join-Path $d $overfitFile) { param($j) $j.PSObject.Properties.Remove('checked') } } '확인한 곳\(checked\)'
Test-Case '과적합 지적이 처리 안 됨' $false { param($d) Edit-Json (Join-Path $d $overfitFile) { param($j) $j.findings = @($j.findings) + [pscustomobject]@{ id = 'selftest'; summary = '자기 점검'; status = 'open' } } }
Test-Case '과적합 지적 fixed인데 시험이 이번 기록에 없음' $false { param($d) Edit-Json (Join-Path $d $overfitFile) { param($j) $j.findings = @($j.findings) + [pscustomobject]@{ id = 'selftest'; summary = '자기 점검'; status = 'fixed'; test = 'no-such-test' } } }
# 검토자 보고서 원문과 처리 기록 잇기: 원문 없이, 원문을 고쳐서, 원문의 지적을 빼고 기록하는 것을 막는지
$reportRel = ((Get-Content -Raw -Encoding UTF8 (Join-Path $repo $overfitFile) | ConvertFrom-Json).report) -replace '/', '\'
Test-Case '과적합 검토 보고서 원문 없음' $false { param($d) Remove-Item (Join-Path $d $reportRel) -Confirm:$false }
Test-Case '과적합 검토 보고서 원문을 기록 뒤 고침(reportHash 다름)' $false { param($d) Add-Content -Encoding UTF8 (Join-Path $d $reportRel) '덧붙인 줄' }
# 기록의 지문이 검토자가 보고서 맨 앞 두 줄(검토 시작·끝 지문)에 적은 지문과 같은지: 검토 뒤 점검 틀을 고치고 기록 지문만 고침 / 보고서 끝에 새 지문을
# 덧붙임 / 머리 지문이 비어 있음 / 시작·끝이 다름
$reportEdit = { param($d, [scriptblock]$change)
  $path = Join-Path $d $reportRel
  [System.IO.File]::WriteAllText($path, (& $change (Get-Content -Raw -Encoding UTF8 $path)), (New-Object System.Text.UTF8Encoding $false))
  $hash = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower()
  Edit-Json (Join-Path $d $overfitFile) { param($j) $j.reportHash = $hash } }
$newHarness = { param($d)
  Add-Content -Encoding UTF8 (Join-Path $d 'tools\public-copy-check.js') '// 검토 뒤에 고친 줄'
  ((& node (Join-Path $d 'tools\gate-hashes.js')) | Out-String | ConvertFrom-Json).harnessHash }
Test-Case '검토 뒤 점검 틀을 고치고 기록 지문만 지금 값으로 고침' $false { param($d)
  $harness = & $newHarness $d
  Edit-Json (Join-Path $d $overfitFile) { param($j) $j.harnessHash = $harness } }
Test-Case '검토 뒤 점검 틀을 고치고 보고서 끝에 새 지문 줄을 덧붙임' $false { param($d)
  $harness = & $newHarness $d
  & $reportEdit $d { param($text) $text + "`n검토 끝 지문: harnessHash $harness`n" }
  Edit-Json (Join-Path $d $overfitFile) { param($j) $j.harnessHash = $harness } }
Test-Case '과적합 검토 보고서 머리 지문이 비어 있음' $false { param($d)
  $record = Get-Content -Raw -Encoding UTF8 (Join-Path $d $overfitFile) | ConvertFrom-Json
  & $reportEdit $d { param($text) $text.Replace([string]$record.contentHash, '').Replace([string]$record.harnessHash, '').Replace([string]$record.promptHash, '') } }
Test-Case '과적합 검토 보고서의 시작·끝 지문이 다름' $false { param($d)
  & $reportEdit $d { param($text) ([regex]'(검토 끝 지문[^\n]*?testsHash\W+)([0-9a-f]{64})').Replace($text, [System.Text.RegularExpressions.MatchEvaluator] { param($m) $m.Groups[1].Value + ('0' * 64) }, 1) } }
# 보고서 원문의 저장소 밖 출처(검토 보조 에이전트 기록): 머리 지문을 바꿔 쓰고 기록도 맞추면 출처와 달라 막힘, 출처 없음도 막힘
Test-Case '검토 뒤 점검 틀을 고치고 보고서 머리 지문·기록 지문·reportHash를 함께 고쳐 씀(출처와 다름)' $false { param($d)
  $harness = & $newHarness $d
  $record = Get-Content -Raw -Encoding UTF8 (Join-Path $d $overfitFile) | ConvertFrom-Json
  & $reportEdit $d { param($text) $text.Replace([string]$record.harnessHash, $harness) }
  Edit-Json (Join-Path $d $overfitFile) { param($j) $j.harnessHash = $harness } } '출처'
Test-Case '원문 출처가 한 줄짜리 가짜 기록' $false { param($d)
  $record = Get-Content -Raw -Encoding UTF8 (Join-Path $d $overfitFile) | ConvertFrom-Json
  $text = [System.IO.File]::ReadAllText((Join-Path $d $reportRel), (New-Object System.Text.UTF8Encoding $false))
  $place = & $sourcePlace $d ([guid]::NewGuid().ToString())
  $line = [pscustomobject]@{ message = [pscustomobject]@{ content = @([pscustomobject]@{ type = 'tool_use'; name = 'SubagentHandback'; input = [pscustomobject]@{ message = $text } }) } } | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText((Join-Path $place 'agent-forged1.jsonl'), $line + "`n", (New-Object System.Text.UTF8Encoding $false))
  Edit-Json (Join-Path $d $overfitFile) { param($j) $j.reportSource = (Join-Path $place 'agent-forged1.jsonl') } } '꼴'
Test-Case '검토 뒤 점검 틀을 고치고 실제 기록 사본의 돌려준 글 머리 지문까지 바꿔 씀' $false { param($d)
  $harness = & $newHarness $d
  $record = Get-Content -Raw -Encoding UTF8 (Join-Path $d $overfitFile) | ConvertFrom-Json
  & $reportEdit $d { param($text) $text.Replace([string]$record.harnessHash, $harness) }
  $source = [string]$record.reportSource; $rows = [System.IO.File]::ReadAllLines($source, (New-Object System.Text.UTF8Encoding $false))
  # 기록 끝의 훅 실행 줄(attachment)도 SubagentHandback 이름을 담는다 — 돌려준 글(도구 호출) 줄을 찾는다
  $last = [array]::FindLastIndex($rows, [Predicate[string]] { param($r) $r -match '"name":"SubagentHandback"' })
  $rows[$last] = $rows[$last].Replace([string]$record.harnessHash, $harness)
  [System.IO.File]::WriteAllLines($source, $rows, (New-Object System.Text.UTF8Encoding $false))
  Edit-Json (Join-Path $d $overfitFile) { param($j) $j.harnessHash = $harness } } '꼴'
Test-Case '원문 출처 기록의 첫 글에 고정 지시문이 없음' $false { param($d) & $newReview $d -noPrompt } '꼴'
Test-Case '원문 출처 기록이 지시문 파일을 가리켰지만 읽은 결과에 지시문 글이 없음' $false { param($d) & $newReview $d -unread } '꼴'
# 검토자가 고른 도구(PowerShell로 지문 재기·Get-Content로 지시문 읽기)로는 막지 않는다
Test-Case '원문 출처 기록이 PowerShell로 지문을 재고 지시문을 읽음' $true { param($d) & $newReview $d -shell }
Test-Case '과적합 검토 기록에 보고서 원문 출처(reportSource)가 없음' $false { param($d) Edit-Json (Join-Path $d $overfitFile) { param($j) $j.PSObject.Properties.Remove('reportSource') } } 'reportSource'
# 고치기 전 판 기록의 판단이 공용 시험 도구(tests/lib)에 있으면 도구도 기록에 묶인다: 기록 뒤 도구를 고치면(전체 시험·검토는 다시 한 것처럼 맞춰도) 막힘
Test-Case '고치기 전 개발판 기록 뒤 시험 도구(tests/lib)를 고침' $false { param($d) & $touchLib $d; & $rebind $d } 'tests/lib'
Test-Case '과적합 검토 보고서의 지적을 기록에서 뺌' $false { param($d)
  Add-Content -Encoding UTF8 (Join-Path $d $reportRel) "`nid: selftest-dropped`n"
  $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $d $reportRel)).Hash.ToLower()
  Edit-Json (Join-Path $d $overfitFile) { param($j) $j.reportHash = $hash } }
# high 지적을 사용자 결정 없이 안 고침으로 닫는 것을 막는지(과적합 검토 3차) — 보고서 원문의 심각도 줄로 high를 안다
$highId = $null; $cur = $null
foreach ($line in Get-Content -Encoding UTF8 (Join-Path $repo $reportRel)) {
  if ($line -match '^\s*[-*]?\s*\**id\**:\s*`?([A-Za-z0-9._-]+)') { $cur = $Matches[1]; continue }
  if ($cur -and -not $highId -and $line -match '심각도\**\s*:\s*\**\s*high') { $highId = $cur }
}
# 보고서에 high 지적이 없으면 사본 보고서·기록에 하나 만들어 넣고 시험한다. fixed 말고는 어떤 상태든 사용자 원문·질문 글이 있어야 한다(4차)
$highOf = { param($d)
  if ($highId) { return $highId }
  Add-Content -Encoding UTF8 (Join-Path $d $reportRel) "`nid: selftest-high`n- 심각도: high`n"
  $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $d $reportRel)).Hash.ToLower()
  Edit-Json (Join-Path $d $overfitFile) { param($j) $j.reportHash = $hash; $j.findings = @($j.findings) + [pscustomobject]@{ id = 'selftest-high'; summary = '자기 점검'; status = 'hardening'; reason = '자기 점검' } }
  # 보고서를 바꿨으니 원문 출처도 그 글을 돌려준 검토 기록 꼴로 다시 둔다
  & $newReview $d
  return 'selftest-high' }
$highAs = { param($d, $status, $withQuote)
  $id = & $highOf $d
  Edit-Json (Join-Path $d $overfitFile) { param($j) $f = $j.findings | Where-Object { $_.id -eq $id }; $f.status = $status; $f | Add-Member -Force reason '자기 점검'
    if ($withQuote) { $f | Add-Member -Force quote '그대로 둬'; $f | Add-Member -Force question '고치지 않고 낼까요?' } else { $f.PSObject.Properties.Remove('quote'); $f.PSObject.Properties.Remove('question') } } }
foreach ($status in 'wontfix', 'not-a-bug', 'hardening') {
  Test-Case "high 지적을 사용자 원문 없이 $status" $false { param($d) & $highAs $d $status $false }
}
Test-Case 'high 지적 wontfix + 사용자 원문·질문 글' $true { param($d) & $highAs $d 'wontfix' $true }

# 중간 회차 보고서(review의 reports)에도 같은 묶음 규칙(과적합 검토 5차): 지적을 빼거나, 원문을 고치거나, high를 원문 없이 닫거나, 묶지 않은 회차 보고서를 두면 막는지
$reviewFile = "release\review-$version.json"
$midReports = @((Get-Content -Raw -Encoding UTF8 (Join-Path $repo $reviewFile) | ConvertFrom-Json).reports)
if (-not $midReports.Count) { Write-Output 'FAIL  검토 기록에 중간 회차 보고서 묶음(reports)이 없어 중간 회차 경우를 시험하지 못함'; $failures++ }
else {
  $midRel = $midReports[0].report -replace '/', '\'
  $midIds = @(); $midHigh = $null; $cur = $null
  foreach ($line in Get-Content -Encoding UTF8 (Join-Path $repo $midRel)) {
    if ($line -match '^\s*[-*]?\s*\**id\**:\s*`?([A-Za-z0-9._-]+)') { $cur = $Matches[1]; $midIds += $cur; continue }
    if ($cur -and -not $midHigh -and $line -match '심각도\**\s*:\s*\**\s*high') { $midHigh = $cur }
  }
  Test-Case '중간 회차 보고서의 지적을 처리 기록에서 뺌' $false { param($d) Edit-Json (Join-Path $d $reviewFile) { param($j) $j.findings = @($j.findings | Where-Object { $_.id -ne $midIds[0] }) } }
  Test-Case '중간 회차 보고서 원문을 기록 뒤 고침(reportHash 다름)' $false { param($d) Add-Content -Encoding UTF8 (Join-Path $d $midRel) '덧붙인 줄' }
  # 그 보고서에 high가 없으면 사본 보고서·기록에 하나 만든다
  $midHighOf = { param($d)
    if ($midHigh) { return $midHigh }
    Add-Content -Encoding UTF8 (Join-Path $d $midRel) "`nid: selftest-mid-high`n- 심각도: high`n"
    $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $d $midRel)).Hash.ToLower()
    Edit-Json (Join-Path $d $reviewFile) { param($j) $j.reports[0].reportHash = $hash; $j.findings = @($j.findings) + [pscustomobject]@{ id = 'selftest-mid-high'; summary = '자기 점검'; status = 'hardening'; reason = '자기 점검' } }
    return 'selftest-mid-high' }
  $midHighAs = { param($d, $status, $withQuote)
    $id = & $midHighOf $d
    Edit-Json (Join-Path $d $reviewFile) { param($j) $f = $j.findings | Where-Object { $_.id -eq $id }; $f.status = $status; $f | Add-Member -Force reason '자기 점검'
      if ($withQuote) { $f | Add-Member -Force quote '그대로 둬'; $f | Add-Member -Force question '고치지 않고 낼까요?' } else { $f.PSObject.Properties.Remove('quote'); $f.PSObject.Properties.Remove('question') } } }
  Test-Case '중간 회차 high 지적을 사용자 원문 없이 hardening' $false { param($d) & $midHighAs $d 'hardening' $false }
  Test-Case '중간 회차 high 지적 wontfix + 사용자 원문·질문 글' $true { param($d) & $midHighAs $d 'wontfix' $true }
}
Test-Case '처리 기록에 묶이지 않은 회차 보고서가 있음' $false { param($d) Set-Content -Encoding UTF8 (Join-Path $d "release\overfit-report-$version-selftest.md") "id: selftest-unbound`n- 심각도: low" }

# 고치기 전 판에서 실패한 시험이어야 고침의 근거(과적합 검토 3차): 실행기 기록(base-run.json) 없음·고치기 전에도 통과·기준 판 다름·기록 뒤 시험 파일 바뀜을 막는지
$baseFile = 'release\base-run.json'
$firstFix = @((Get-Content -Raw -Encoding UTF8 (Join-Path $repo $changesFile) | ConvertFrom-Json).changes | Where-Object { $_.origin -eq 'fix' } | Select-Object -First 1).test
Test-Case '고치기 전 판 실행 기록 없음' $false { param($d) Remove-Item (Join-Path $d $baseFile) -Confirm:$false }
Test-Case "고침의 확인 시험($firstFix)이 고치기 전 판에서도 통과" $false { param($d) Edit-Json (Join-Path $d $baseFile) { param($j) $j.cases.PSObject.Properties[$firstFix].Value.status = 'PASS' } }
Test-Case '고치기 전 판 기록이 바뀐 점 기준 판과 다름' $false { param($d) Edit-Json (Join-Path $d $changesFile) { param($j) $j.baseContentHash = '0' * 64 } }
Test-Case '고치기 전 판으로 돌린 뒤 시험 파일이 바뀜' $false { param($d) Edit-Json (Join-Path $d $baseFile) { param($j) $j.cases.PSObject.Properties[$firstFix].Value.fileHash = '0' * 64 } }

# 확인 단위·회귀 근거(과적합 검토 6차): 실패해야 할 확인이 고치기 전 판에서도 통과, 회귀인데 고치기 전 개발판 기록 없음·확인 없음을 막는지, 맞으면 통과하는지
$baseCases = (Get-Content -Raw -Encoding UTF8 (Join-Path $repo $baseFile) | ConvertFrom-Json).cases
$fixedReview = @((Get-Content -Raw -Encoding UTF8 (Join-Path $repo $reviewFile) | ConvertFrom-Json).findings | Where-Object { $_.status -eq 'fixed' -and -not $_.regression })
$okPick = $null
foreach ($f in $fixedReview) { $e = $baseCases.PSObject.Properties[$f.test]; $c = if ($e) { @($e.Value.checks | Where-Object { $_.ok }) | Select-Object -First 1 } else { $null }; if ($c) { $okPick = @{ id = $f.id; label = $c.label }; break } }
if ($okPick) {
  Test-Case '실패해야 할 확인(failCheck)이 고치기 전 판에서도 통과' $false { param($d) Edit-Json (Join-Path $d $reviewFile) { param($j) $f = $j.findings | Where-Object { $_.id -eq $okPick.id }; $f | Add-Member -Force failCheck $okPick.label } } '기록에서도 통과합니다'
} else { Write-Output 'FAIL  고치기 전 판 기록에 통과한 확인이 있는 fixed 지적이 없어 failCheck 경우를 시험하지 못함'; $failures++ }
$someFixed = $fixedReview | Select-Object -First 1
Test-Case '회귀(regression)인데 고치기 전 개발판 기록이 없음' $false { param($d) Edit-Json (Join-Path $d $reviewFile) { param($j) $f = $j.findings | Where-Object { $_.id -eq $someFixed.id }; $f | Add-Member -Force regression $true; $f | Add-Member -Force devBase ('0' * 64); $f | Add-Member -Force failCheck 'x' } }
Test-Case '회귀(regression)인데 실패해야 할 확인(failCheck)이 없음' $false { param($d) Edit-Json (Join-Path $d $reviewFile) { param($j) $f = $j.findings | Where-Object { $_.id -eq $someFixed.id }; $f | Add-Member -Force regression $true; $f | Add-Member -Force devBase ('0' * 64); $f.PSObject.Properties.Remove('failCheck') } }
$devFile = Join-Path $repo 'release\dev-base-run.json'
$regression = @((Get-Content -Raw -Encoding UTF8 (Join-Path $repo $reviewFile) | ConvertFrom-Json).findings | Where-Object { $_.status -eq 'fixed' -and $_.regression }) | Select-Object -First 1
if ($regression -and (Test-Path $devFile)) {
  Test-Case '회귀 + 고치기 전 개발판 기록에서 그 확인이 실패(실제 기록)' $true { param($d) }
  Test-Case '회귀인데 그 확인이 고치기 전 개발판에서 통과(기록을 통과로 바꿈)' $false { param($d)
    Edit-Json (Join-Path $d 'release\dev-base-run.json') { param($j) $c = $j.bases.PSObject.Properties[$regression.devBase].Value.cases.PSObject.Properties[$regression.test].Value; foreach ($x in @($c.checks | Where-Object { $_.label -eq $regression.failCheck })) { $x.ok = $true } } }
} else { Write-Output 'FAIL  회귀 지적 기록(regression·devBase·failCheck)이나 release\dev-base-run.json이 없어 회귀 경우를 시험하지 못함'; $failures++ }

if ($failures) { Write-Output "자기 점검 실패 $failures 건"; exit 1 }
Write-Output '자기 점검 통과: 관문이 막아야 할 때 막고, 기록이 맞을 때만 zip을 만든다.'
