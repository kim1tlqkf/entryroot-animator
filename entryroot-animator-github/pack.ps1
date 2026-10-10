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
