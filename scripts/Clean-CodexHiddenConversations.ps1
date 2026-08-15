[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$KeepRollouts
)

$ErrorActionPreference = 'Stop'

$running = Get-Process -Name Codex, ChatGPT -ErrorAction SilentlyContinue
if ($running) {
  Write-Error 'Codex Desktop is still running. Exit it completely, then run this script again.'
  exit 1
}

$pythonScript = Join-Path $PSScriptRoot 'clean_codex_hidden_conversations.py'
if (-not (Test-Path -LiteralPath $pythonScript -PathType Leaf)) {
  Write-Error "Missing cleanup program: $pythonScript"
  exit 1
}

$pythonArgs = @()
if ($DryRun) { $pythonArgs += '--dry-run' }
if ($KeepRollouts) { $pythonArgs += '--keep-rollouts' }

$pythonLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pythonLauncher) {
  $pythonPath = $pythonLauncher.Source
  & $pythonPath -3 $pythonScript @pythonArgs
} else {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) {
    Write-Error 'Python 3 was not found. Install Python 3, then run this script again.'
    exit 1
  }
  $pythonPath = $python.Source
  & $pythonPath $pythonScript @pythonArgs
}

exit $LASTEXITCODE
