# Regenerate the offline Gradle mirror (E:\Codex Remote APP\.gradle-mirror)
# from the on-disk Gradle module cache (~\.gradle\caches\modules-2\files-2.1).
# Layout: files-2.1 uses <group-dotted>\<artifact>\<version>\<hash>\<file>;
# Maven wants <group split on dots>\<artifact>\<version>\<file>.
#
# Usage:  pwsh -NoProfile -File android/build-gradle-mirror.ps1
# Then:   cd android; .\gradlew.bat assembleDebug --offline --init-script offline-mirror.init.gradle
$ErrorActionPreference = 'Stop'
$src = Join-Path $env:USERPROFILE '.gradle\caches\modules-2\files-2.1'
$root = Split-Path -Parent $PSScriptRoot          # repo root (E:\Codex Remote APP)
$mirror = Join-Path $root '.gradle-mirror'
if (Test-Path $mirror) { Remove-Item -Recurse -Force $mirror }
New-Item -ItemType Directory -Path $mirror | Out-Null

$files = @(Get-ChildItem $src -Recurse -File)
$count = 0; $skip = 0
foreach ($f in $files) {
  $hashDir = Split-Path $f.FullName -Parent
  $versionDir = Split-Path $hashDir -Parent
  if ($versionDir.Length -le $src.Length) { $skip++; continue }
  $rel = $versionDir.Substring($src.Length).TrimStart('\')
  $parts = $rel -split '\\'
  if ($parts.Count -lt 3) { $skip++; continue }
  $groupPath = ($parts[0] -split '\.') -join '\'
  $mavenRel = ($groupPath, $parts[1], $parts[2]) -join '\'
  $targetDir = Join-Path $mirror $mavenRel
  if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
  Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $targetDir $f.Name) -Force
  $count++
}
Write-Output ('copied=' + $count + ' skipped=' + $skip)
$probe = "$mirror\com\android\tools\build\gradle\8.13.0\gradle-8.13.0.pom"
Write-Output ('AGP pom present=' + (Test-Path $probe))
