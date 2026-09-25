$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$start = Join-Path $here 'start-watcher.ps1'
$taskName = 'DSH-Alert-Watcher'

# 动作带 -IfDown：计划任务同时充当"看门狗"。原来只有登录触发器，监测进程一旦被杀
# （例如 2026-09-25 10:20 那次 DSH 重启把它一起带走），就再也不会自己回来，
# 之后所有断网/等待决策的邮件都发不出去。现在每 15 分钟巡检一次，不在跑就拉起。
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $start + '" -IfDown')
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 365)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($atLogon, $watchdog) -Settings $settings -Principal $principal -Force | Out-Null
$task = Get-ScheduledTask -TaskName $taskName
Write-Output ('task registered: ' + $task.TaskName + ' state=' + $task.State + ' triggers=' + $task.Triggers.Count)
