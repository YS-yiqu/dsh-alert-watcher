$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$hbFile = Join-Path $here 'watcher.json'
$pidFile = Join-Path $here 'watcher.pid'

# 以心跳里的 pid 为准（那是 node 自己的 process.pid，即真正在跑的那个进程）；
# 命令行匹配只作为兜底，清扫历史遗留的孤儿进程。
$stopped = 0
if (Test-Path -LiteralPath $hbFile) {
  try {
    $j = [System.IO.File]::ReadAllText($hbFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if (Get-Process -Id ([int]$j.pid) -ErrorAction SilentlyContinue) {
      & taskkill /PID ([int]$j.pid) /T /F 2>&1 | Out-Null
      Write-Output ('watcher stopped, pid=' + $j.pid)
      $stopped++
    }
  } catch { }
}
$pat = 'dsh-alert\.mjs\s*"?\s*$'
$stray = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Trim() -match $pat })
foreach ($t in $stray) {
  & taskkill /PID $t.ProcessId /T /F 2>&1 | Out-Null
  Write-Output ('stray watcher stopped, pid=' + $t.ProcessId)
  $stopped++
}
if ($stopped -eq 0) { Write-Output 'watcher not running' }
Remove-Item -LiteralPath $hbFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
