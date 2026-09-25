param(
  [Parameter(Mandatory = $true)][string]$MessageFile
)
$ErrorActionPreference = 'Stop'
try {
  $lines = @(Get-Content -LiteralPath $MessageFile -Encoding UTF8)
  $title = if ($lines.Count -gt 0) { $lines[0].Trim() } else { 'DSH' }
  $body = (($lines[1..($lines.Count - 1)]) -join "`n").Trim()
  if ($body.Length -gt 700) { $body = $body.Substring(0, 700) + ' ...' }

  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $safeTitle = [System.Security.SecurityElement]::Escape($title)
  $safeBody = [System.Security.SecurityElement]::Escape($body)
  $xmlText = '<toast duration="long"><visual><binding template="ToastGeneric"><text>' + $safeTitle + '</text><text>' + $safeBody + '</text></binding></visual></toast>'
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  Write-Output 'toast shown'
  exit 0
} catch {
  Write-Error ('toast failed: ' + $_.Exception.Message)
  exit 1
}
