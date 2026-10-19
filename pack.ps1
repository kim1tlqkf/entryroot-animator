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

# ---- 출시 관문(2026-10-16) ----
# 1.2.0은 사용자의 가벼운 승인과 그때까지의 시험 통과만 믿고 냈다가 숨은 버그가 10개 넘게 나왔다(사용자: "대충 해 놓고 승인하자고 해도
# 믿지 마라"). 그래서 zip은 아래가 모두 맞을 때만 만든다. 사용자 승인으로 넘기는 길(옵션)은 두지 않는다.
#  1) release\last-full-run.json — tests\run.js로 이 저장소 확장의 모든 시험을 돌린 기록. 지금 파일 지문(contentHash)·버전이 같고 모두 통과.
#  2) release\review-<버전>.json — 독립 검토 기록. reviewers·scope가 있고, 지적(findings)마다 status가
#     fixed(test = 1)의 기록에서 PASS인 시험 이름) / hardening·wontfix·not-a-bug(reason 필수) 중 하나. open이 하나라도 있으면 안 됨.
#  3) release\changes-<버전>.json — 바뀐 점 출처 기록(2026-10-19 추가). 1.2.1의 '작품 저장 확인'은 시험·검토를 다 거쳤지만 원인 미확인 제보에
#     맞춘 짐작 기능이었다(사용자: "과적합돼서 상관없는 기능을 넣은 것 같은데", "내가 귀찮아서 테스트 건너뛰고 너 말을 믿으면 어떻게 할건데").
#     그래서 바뀐 점마다 왜 들어갔는지를 기계가 본다: request(사용자 원문 quote + 확인 시험, 내 선택지에 대한 답이면 premise = 'preference'
#     또는 그 사실 전제를 확인한 시험 이름) / fix(제보 원문 report + reproduced 참 + 확인 시험 + failsBefore — 재현 못 한 고침은 막음) /
#     hardening(새 동작 없음 선언 noNewBehavior 참 + reason — 새 기능을 '예방'이라 부르는 길을 막음) / removal(사용자 원문 quote + reason).
# 지문: 파일 경로 서수 순서로 "경로:파일SHA256(소문자)\n"을 이어 붙인 UTF-8 글의 SHA256 — tests\run.js의 releaseHash와 같은 방법.
function Stop-Release($message) { throw "출시 관문: $message (release\README.md 참고)" }
$sorted = [string[]]$files.Clone()
[Array]::Sort($sorted, [StringComparer]::Ordinal)
$text = ($sorted | ForEach-Object { "$($_):$((Get-FileHash -Algorithm SHA256 (Join-Path $root ($_ -replace '/', '\'))).Hash.ToLower())`n" }) -join ''
$sha = [System.Security.Cryptography.SHA256]::Create()
$contentHash = (($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join '')
$runPath = Join-Path $root 'release\last-full-run.json'
if (-not (Test-Path $runPath)) { Stop-Release '전체 시험 기록이 없습니다 — node tests/run.js 를 먼저 돌리세요' }
$run = Get-Content -Raw -Encoding UTF8 $runPath | ConvertFrom-Json
if ($run.version -ne $manifest.version) { Stop-Release "시험 기록 버전($($run.version))이 manifest($($manifest.version))와 다릅니다" }
if ($run.contentHash -ne $contentHash) { Stop-Release '시험을 돌린 뒤 확장 파일이 바뀌었습니다 — 전체 시험을 다시 돌리세요' }
if (-not $run.allPassed) { Stop-Release '전체 시험에 통과 못 한 것이 있습니다' }
# 시험 폴더의 시험은 모두 이번 기록에 있어야 한다 — 시험을 새로 넣고 전체 시험을 다시 안 돌리면 새 시험이 관문을 거치지 않고 빠졌다(2026-10-19
# 모양 섞임 시험을 넣으며 찾음, 사용자 "내가 테스트를 한다고 가정하지 말고"). 시험 폴더가 없는 사본(GitHub 사본)은 기록의 통과만 본다.
$caseDir = Join-Path $root 'tests\cases'
if (Test-Path $caseDir) {
  if (-not $run.caseFiles) { Stop-Release '전체 시험 기록에 시험 파일 목록이 없습니다(예전 기록) — 전체 시험을 다시 돌리세요' }
  $notRun = @(Get-ChildItem $caseDir -Filter '*.js' -File | ForEach-Object { $_.Name } | Where-Object { @($run.caseFiles) -notcontains $_ })
  if ($notRun.Count) { Stop-Release "전체 시험 기록에 없는 시험이 있습니다($($notRun -join ', ')) — 전체 시험을 다시 돌리세요" }
}
$reviewPath = Join-Path $root "release\review-$($manifest.version).json"
if (-not (Test-Path $reviewPath)) { Stop-Release "이 버전의 독립 검토 기록(release\review-$($manifest.version).json)이 없습니다" }
$review = Get-Content -Raw -Encoding UTF8 $reviewPath | ConvertFrom-Json
if ($review.version -ne $manifest.version) { Stop-Release '검토 기록의 버전이 다릅니다' }
if (-not $review.reviewers -or -not $review.scope) { Stop-Release '검토 기록에 reviewers·scope가 없습니다' }
$passed = @($run.cases | Where-Object { $_.status -eq 'PASS' } | ForEach-Object { $_.name })
foreach ($finding in @($review.findings)) {
  switch ($finding.status) {
    'fixed' { if (-not $finding.test -or $passed -notcontains $finding.test) { Stop-Release "지적 $($finding.id): 고쳤다는데 확인 시험($($finding.test))이 이번 전체 시험에서 통과하지 않았습니다" } }
    { $_ -in 'hardening', 'wontfix', 'not-a-bug' } { if (-not $finding.reason) { Stop-Release "지적 $($finding.id): $($finding.status)인데 이유(reason)가 없습니다" } }
    default { Stop-Release "지적 $($finding.id): 처리되지 않았습니다(status=$($finding.status))" }
  }
}
$changesPath = Join-Path $root "release\changes-$($manifest.version).json"
if (-not (Test-Path $changesPath)) { Stop-Release "이 버전의 바뀐 점 출처 기록(release\changes-$($manifest.version).json)이 없습니다" }
$changes = Get-Content -Raw -Encoding UTF8 $changesPath | ConvertFrom-Json
if ($changes.version -ne $manifest.version) { Stop-Release '바뀐 점 기록의 버전이 다릅니다' }
if (-not @($changes.changes).Count) { Stop-Release '바뀐 점 기록에 항목이 없습니다' }
$passedTest = { param($name) $name -and $passed -contains $name }
foreach ($change in @($changes.changes)) {
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
Write-Output "출시 관문 통과: 시험 $(@($run.cases).Count)종 모두 통과($($run.at)), 검토 지적 $(@($review.findings).Count)개 처리됨, 바뀐 점 $(@($changes.changes).Count)개 출처 확인"

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
