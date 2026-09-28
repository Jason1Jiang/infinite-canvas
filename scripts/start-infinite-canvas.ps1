$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$bun = "$env:LOCALAPPDATA\CodexPortableBun\bun-v1.3.13-windows-x64\bun.exe"
$node = "$HOME\.nodejs\node-v22.23.1-win-x64\node.exe"
$agentEntry = "$repoRoot\canvas-agent\dist\index.js"
$logDir = "$HOME\.infinite-canvas"

function Test-ListeningPort([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

if (!(Test-Path $bun)) { throw "未找到 Bun：$bun" }
if (!(Test-Path $node)) { throw "未找到 Node.js：$node" }
if (!(Test-Path $agentEntry)) { throw "未找到 Canvas Agent 构建：$agentEntry" }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (!(Test-ListeningPort 3000)) {
    Start-Process -FilePath $bun -ArgumentList @("run", "dev") -WorkingDirectory "$repoRoot\web" -WindowStyle Hidden `
        -RedirectStandardOutput "$logDir\infinite-canvas-web.stdout.log" -RedirectStandardError "$logDir\infinite-canvas-web.stderr.log"
}

if (!(Test-ListeningPort 17371)) {
    Start-Process -FilePath $node -ArgumentList @($agentEntry) -WorkingDirectory "$repoRoot\canvas-agent" -WindowStyle Hidden `
        -RedirectStandardOutput "$logDir\canvas-agent.stdout.log" -RedirectStandardError "$logDir\canvas-agent.stderr.log"
}
