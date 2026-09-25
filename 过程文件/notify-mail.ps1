param(
  [Parameter(Mandatory = $true)][string]$MessageFile,
  [Parameter(Mandatory = $true)][string]$To,
  [string]$Account = ''
)
$ErrorActionPreference = 'Stop'
# 发信要点：
#   1) Outlook 刚崩溃或刚重启时 COM 会失败（如 800706BE 远程过程调用失败），因此重试 3 次；
#   2) Send() 之后等它离开发件箱再报结果：已离开=sent，仍在发件箱=queued（离线时 Outlook 自己
#      排队、联网后自动发出），两种情况都算交接成功、都不要再补发，避免收件人收到重复邮件；
#   3) 只有 COM 彻底失败（邮件根本没交给 Outlook）才以 exit 1 结束，由监测器放进待发队列补发；
#   4) 不调用 Quit()：让 Outlook 常驻，离线时排队的邮件才能在联网后自己发出去。
try {
  $lines = @(Get-Content -LiteralPath $MessageFile -Encoding UTF8)
  if ($lines.Count -eq 0) { throw 'empty message file' }
  $subject = $lines[0].Trim()
  $body = (($lines[1..($lines.Count - 1)]) -join "`r`n").Trim()

  $recipients = @($To -split ';' | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() })
  if ($recipients.Count -eq 0) { throw 'no recipient configured' }

  $stamp = (Get-Date).ToString('s')
  $lastErr = ''
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $ol = New-Object -ComObject Outlook.Application
      $ns = $ol.GetNamespace('MAPI')
      $mail = $ol.CreateItem(0)
      if ($Account -ne '') {
        foreach ($a in $ns.Accounts) { if ($a.SmtpAddress -eq $Account) { $mail.SendUsingAccount = $a } }
      }
      $mail.To = ($recipients -join ';')
      $mail.Subject = $subject
      $mail.Body = $body
      $mail.Send()

      $offline = $false
      try { $offline = [bool]$ns.Offline } catch { }
      $deadline = (Get-Date).AddSeconds(20)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 800
        $still = $false
        try {
          foreach ($it in $ns.GetDefaultFolder(4).Items) {
            if ($it.Subject -eq $subject) { $still = $true; break }
          }
        } catch { }
        if (-not $still) {
          Write-Output ('sent to ' + ($recipients -join ',') + ' at ' + $stamp + ' (attempt ' + $attempt + ')')
          exit 0
        }
      }
      if ($offline) {
        Write-Output ('queued (offline) to ' + ($recipients -join ',') + ' at ' + $stamp)
      } else {
        Write-Output ('queued (still in outbox) to ' + ($recipients -join ',') + ' at ' + $stamp)
      }
      exit 0
    } catch {
      $lastErr = $_.Exception.Message
      if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
    }
  }
  Write-Error ('mail failed after 3 attempts: ' + $lastErr)
  exit 1
} catch {
  Write-Error ('mail failed: ' + $_.Exception.Message)
  exit 1
}
