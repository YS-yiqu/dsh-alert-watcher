param([switch]$IfDown)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptFile = Join-Path $here 'dsh-alert.mjs'
$pidFile = Join-Path $here 'watcher.pid'
$hbFile = Join-Path $here 'watcher.json'

# 「有没有在跑」只认监测器自己写的心跳（watcher.json），不做命令行字符串匹配：
# nvm 的 .nodejs\node.exe 是代理壳，不同启动方式命令行写法会变，匹配容易误判 →
# 误判成"没在跑"就会重复起进程、重复发提醒邮件（2026-09-25 实测发生过）。
# 心跳里的 pid 是 node 自己的 process.pid，即真正在跑的那个进程，杀掉它才真停。
function Get-EpochMs { return [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01 00:00:00Z')).TotalMilliseconds }

function Test-WatcherAlive {
  param([int]$MaxAgeSec = 60)
  if (-not (Test-Path -LiteralPath $hbFile)) { return $false }
  try {
    $j = [System.IO.File]::ReadAllText($hbFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $age = (Get-EpochMs) - [int64]$j.at
    if ($age -gt ($MaxAgeSec * 1000)) { return $false }
    return [bool](Get-Process -Id ([int]$j.pid) -ErrorAction SilentlyContinue)
  } catch { return $false }
}

# 兜底清扫：命令行以 dsh-alert.mjs 结尾的 node 进程（防历史遗留的孤儿）
function Clear-StrayWatchers {
  $pat = 'dsh-alert\.mjs\s*"?\s*$'
  $stray = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Trim() -match $pat })
  foreach ($t in $stray) {
    & taskkill /PID $t.ProcessId /T /F 2>&1 | Out-Null
    Write-Output ('stopped stray watcher pid=' + $t.ProcessId)
  }
  return $stray.Count
}

function Resolve-RealNode {
  # 用 node 自报的 process.execPath，它指向真正的 node.exe（不是 nvm 的壳），换版本也不用改脚本。
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    try {
      $p = (& node -p "process.execPath" 2>$null | Select-Object -First 1)
      if ($p -and (Test-Path -LiteralPath $p.Trim())) { return $p.Trim() }
    } catch { }
  }
  $installs = Join-Path $env:LOCALAPPDATA 'Author Software\nvm\installs'
  if (Test-Path -LiteralPath $installs) {
    $hit = Get-ChildItem -LiteralPath $installs -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'node.exe' } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending |
      Select-Object -First 1
    if ($hit) { return $hit }
  }
  $pf = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $pf) { return $pf }
  return $null
}

$alive = Test-WatcherAlive
if ($IfDown -and $alive) { exit 0 }   # 已在跑：静默退出，不打断

if ($alive) {
  $j = [System.IO.File]::ReadAllText($hbFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  Write-Output ('stopping running watcher, pid=' + $j.pid)
  & taskkill /PID ([int]$j.pid) /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 1
}
[void](Clear-StrayWatchers)

$node = Resolve-RealNode
if (-not $node) { Write-Output 'node.exe not found'; exit 1 }

Remove-Item -LiteralPath $hbFile -Force -ErrorAction SilentlyContinue
[void](Start-Process -FilePath $node -ArgumentList ('"' + $scriptFile + '"') -WorkingDirectory $here -WindowStyle Hidden)

# 等心跳出现，确认真的起来了；pid 文件只作参考，判断一律用心跳。
$deadline = (Get-Date).AddSeconds(15)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  if (Test-WatcherAlive -MaxAgeSec 30) { $ok = $true; break }
}
if (-not $ok) { Write-Output 'watcher did NOT start'; exit 1 }
$j = [System.IO.File]::ReadAllText($hbFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Set-Content -LiteralPath $pidFile -Value ([string]$j.pid) -Encoding ASCII
Write-Output ('watcher started, pid=' + $j.pid + '，node=' + $node)
