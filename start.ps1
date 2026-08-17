[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$NoRestartOwned,
    [int]$ServerPort = 8787,
    [int]$WebPort = 5173
)

$ErrorActionPreference = 'Stop'
$AppRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Set-Location -LiteralPath $AppRoot
$StartedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Get-NpmCommand {
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $command) { throw '找不到 npm。请先安装 Node.js 20+，并确认 npm 已加入 PATH。' }
    return $command.Source
}

function Get-ListenerProcesses([int]$Port) {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $seen = @{}
    foreach ($connection in $connections) {
        $processId = [int]$connection.OwningProcess
        if ($seen.ContainsKey($processId)) { continue }
        $seen[$processId] = $true

        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
        $name = if ($process) { [string]$process.Name } else { '<进程不可读>' }
        $commandLine = if ($process) { [string]$process.CommandLine } else { '' }
        if (-not $process) {
            $localProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if ($localProcess) { $name = [string]$localProcess.ProcessName }
        }

        [PSCustomObject]@{
            Port = $Port
            ProcessId = $processId
            Name = $name
            CommandLine = $commandLine
        }
    }
}

function Stop-ProcessTree([int]$ProcessId) {
    if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return }
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) { Stop-ProcessTree -ProcessId ([int]$child.ProcessId) }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Test-OwnedCommand([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $normalized = $CommandLine.Replace('%20', ' ').Replace('"', ' ').Replace('/', '\')
    $root = $AppRoot.TrimEnd('\', '/')
    $rootIndex = $normalized.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase)
    if ($rootIndex -lt 0) { return $false }
    $beforeBoundary = $rootIndex -eq 0 -or [char]::IsWhiteSpace($normalized[$rootIndex - 1])
    $afterIndex = $rootIndex + $root.Length
    $afterBoundary = $afterIndex -ge $normalized.Length -or
        [char]::IsWhiteSpace($normalized[$afterIndex]) -or
        $normalized[$afterIndex] -eq '\' -or $normalized[$afterIndex] -eq '/'
    if (-not $beforeBoundary -or -not $afterBoundary) { return $false }
    # Require a recognizable npm/dev child command as a second signal. This
    # avoids treating an unrelated process that merely mentions the directory
    # as an owned process eligible for recursive termination.
    return $normalized -match '(?i)(npm(\.cmd)?\s+run\s+dev|node_modules|[\\/]tsx[\\/]dist|[\\/]vite[\\/]bin|concurrently)'
}

function Assert-PortsAvailable {
    $ports = @($ServerPort, $WebPort) | Sort-Object -Unique
    $listeners = @(
        foreach ($port in $ports) {
            Get-ListenerProcesses -Port $port
        }
    )
    if ($listeners.Count -eq 0) { return }

    if ($NoRestartOwned) {
        $details = ($listeners | ForEach-Object {
            $command = if ($_.CommandLine) { $_.CommandLine } else { '<命令行不可读>' }
            "端口 $($_.Port)：PID $($_.ProcessId), $($_.Name)，命令行：$command"
        }) -join [Environment]::NewLine
        throw "检测到目标端口被占用。已通过 -NoRestartOwned 禁用自动清理：$details"
    }

    $stopped = @{}
    foreach ($listener in $listeners) {
        if ($stopped.ContainsKey($listener.ProcessId)) { continue }
        $stopped[$listener.ProcessId] = $true
        $owner = if (Test-OwnedCommand $listener.CommandLine) { '本项目' } else { '占用进程' }
        Write-Host "清理端口 $($listener.Port) 的$owner PID $($listener.ProcessId)（$($listener.Name)）..." -ForegroundColor Yellow
        Stop-ProcessTree -ProcessId $listener.ProcessId
    }

    $deadline = (Get-Date).AddSeconds(5)
    do {
        $remaining = @(
            foreach ($port in $ports) {
                Get-ListenerProcesses -Port $port
            }
        )
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    $details = ($remaining | ForEach-Object {
        $command = if ($_.CommandLine) { $_.CommandLine } else { '<命令行不可读>' }
        "端口 $($_.Port)：PID $($_.ProcessId), $($_.Name)，命令行：$command"
    }) -join [Environment]::NewLine
    throw "清理目标端口后仍被占用：$details"
}

function Start-NpmScript([string[]]$Arguments, [int]$Port = 0, [string]$ApiUrl = '', [switch]$SuppressPairCode) {
   $previousPort = $env:PORT
    $previousApiUrl = $env:VITE_API_URL
   $previousSuppressPairCode = $env:CODEX_SUPPRESS_PAIR_LOG
   try {
       if ($Port -gt 0) { $env:PORT = [string]$Port }
        if ($ApiUrl) { $env:VITE_API_URL = $ApiUrl }
       if ($SuppressPairCode) { $env:CODEX_SUPPRESS_PAIR_LOG = '1' }
       $process = Start-Process -FilePath (Get-NpmCommand) -ArgumentList $Arguments -WorkingDirectory $AppRoot -NoNewWindow -PassThru
       $StartedProcesses.Add($process)
       return $process
   } finally {
       if ($null -eq $previousPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $previousPort }
        if ($null -eq $previousApiUrl) { Remove-Item Env:VITE_API_URL -ErrorAction SilentlyContinue } else { $env:VITE_API_URL = $previousApiUrl }
       if ($null -eq $previousSuppressPairCode) { Remove-Item Env:CODEX_SUPPRESS_PAIR_LOG -ErrorAction SilentlyContinue } else { $env:CODEX_SUPPRESS_PAIR_LOG = $previousSuppressPairCode }
    }
}

function Wait-Http([string]$Url, [System.Diagnostics.Process]$Process, [int]$TimeoutSeconds = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ($Process.HasExited) { throw "进程 $($Process.Id) 在服务就绪前退出，退出码 $($Process.ExitCode)。" }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "等待服务 $Url 超时（${TimeoutSeconds} 秒）。"
}

try {
    Write-Host '=== Codex Remote APP 启动 ===' -ForegroundColor Cyan
    Write-Host "项目目录：$AppRoot" -ForegroundColor Gray
    Assert-PortsAvailable

    if ($Build) {
        Write-Host '构建 shared/server/web...' -ForegroundColor Cyan
        & (Get-NpmCommand) run build
        if ($LASTEXITCODE -ne 0) { throw "构建失败，退出码 $LASTEXITCODE。" }
    }

    Write-Host "启动后端（端口 $ServerPort）..." -ForegroundColor Cyan
    $server = Start-NpmScript @('run', 'dev', '-w', '@remote/server') -Port $ServerPort -SuppressPairCode
    Wait-Http -Url "http://127.0.0.1:$ServerPort/health" -Process $server
    Write-Host "后端已就绪：http://127.0.0.1:$ServerPort" -ForegroundColor Green

    Write-Host "启动前端（端口 $WebPort）..." -ForegroundColor Cyan
    $web = Start-NpmScript @('run', 'dev', '-w', '@remote/web', '--', '--port', "$WebPort") -ApiUrl "http://127.0.0.1:$ServerPort"
    Wait-Http -Url "http://127.0.0.1:$WebPort/" -Process $web
    Write-Host "前端已就绪：http://127.0.0.1:$WebPort" -ForegroundColor Green
    Write-Host '按 Ctrl+C 停止前后端；退出时会清理本项目的整个进程树。' -ForegroundColor Gray

    $pair = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$ServerPort/api/pair/code" -TimeoutSec 5
    if ([string]::IsNullOrWhiteSpace([string]$pair.code)) { throw '后端未返回有效配对码。' }
    Write-Host ''
    Write-Host '========================================' -ForegroundColor DarkYellow
    Write-Host '请在网页端输入以下一次性配对码：' -ForegroundColor Yellow
    Write-Host "  $($pair.code)  " -ForegroundColor Black -BackgroundColor Yellow
    Write-Host "有效期至：$($pair.expires_at)" -ForegroundColor Gray
    Write-Host '========================================' -ForegroundColor DarkYellow

    Wait-Process -Id $web.Id
}
finally {
    foreach ($process in @($StartedProcesses | Select-Object -Unique)) {
        if ($process -and -not $process.HasExited) { Stop-ProcessTree -ProcessId $process.Id }
    }
}
