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
Write-Output "출시 관문 통과: 시험 $(@($run.cases).Count)종 모두 통과($($run.at)), 검토 지적 $(@($review.findings).Count)개 처리됨"

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
