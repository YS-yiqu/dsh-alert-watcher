$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$source = Join-Path $here 'test-message.txt'
$outDir = Join-Path $here 'outbox'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$message = Join-Path $outDir 'message.txt'
Copy-Item -LiteralPath $source -Destination $message -Force

$cfgFile = Join-Path $here 'config.json'
$cfg = [System.IO.File]::ReadAllText($cfgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$to = ($cfg.mail.to -join ';')
$account = $cfg.mail.from

Write-Output '--- mail ---'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'notify-mail.ps1') -MessageFile $message -To $to -Account $account
Write-Output ('mail exit=' + $LASTEXITCODE)

Write-Output '--- toast ---'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'notify-toast.ps1') -MessageFile $message
Write-Output ('toast exit=' + $LASTEXITCODE)

# The pending-list file name is Chinese; build it from code points so this
# script stays pure ASCII (Windows PowerShell reads BOM-less files as ANSI).
$pendingName = ([string][char]0x5F85 + [string][char]0x5904 + [string][char]0x7406) + '.md'
$pending = Join-Path $root $pendingName
$template = Join-Path $here '_cmd-src\pending-test.txt'
if (Test-Path $template) {
  $text = [System.IO.File]::ReadAllText($template, [System.Text.Encoding]::UTF8)
  $text = $text.Replace('STAMP', (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
  [System.IO.File]::WriteAllText($pending, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('pending file written: ' + $pending)
}
Write-Output 'done'
