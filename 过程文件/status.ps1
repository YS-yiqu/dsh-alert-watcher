$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptFile = Join-Path $here 'dsh-alert.mjs'
$hbFile = Join-Path $here 'watcher.json'

Write-Output '=== 网络 / 会话一览 ==='
& node $scriptFile --scan

Write-Output ''
# 「在不在跑」看心跳（watcher.json），不看 pid 文件、也不靠命令行匹配：
# nvm 的 .nodejs 是代理壳，旧办法会误判（2026-09-25 实测过误判导致重复起进程）。
$alive = $false
if (Test-Path -LiteralPath $hbFile) {
  try {
    $j = [System.IO.File]::ReadAllText($hbFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $epoch = Get-Date '1970-01-01 00:00:00Z'
    $ageSec = [math]::Round(([int64]((Get-Date).ToUniversalTime() - $epoch).TotalMilliseconds - [int64]$j.at) / 1000, 0)
    $proc = Get-Process -Id ([int]$j.pid) -ErrorAction SilentlyContinue
    if ($proc) {
      $alive = $true
      Write-Output ('监测进程在跑：PID ' + $j.pid + '，心跳 ' + $ageSec + ' 秒前')
      if ($ageSec -gt 60) { Write-Output '  （注意：心跳超过 60 秒没更新，可能卡住了）' }
    } else {
      Write-Output ('心跳里的进程 PID ' + $j.pid + ' 已经不在了 —— 监测进程没在跑')
    }
  } catch { Write-Output '心跳文件读不出来' }
} else {
  Write-Output '还没有心跳文件 —— 监测进程没在跑'
}
if (-not $alive) { Write-Output '  双击「启动提醒.cmd」拉起（计划任务每 15 分钟也会自动拉起）' }

Write-Output ''
Write-Output '=== 最近日志 ==='
$logDir = Join-Path $here 'logs'
$latest = Get-ChildItem -LiteralPath $logDir -Filter 'alert-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) { Get-Content -LiteralPath $latest.FullName -Tail 15 -Encoding UTF8 } else { Write-Output 'no log yet' }
