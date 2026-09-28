$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$start = Join-Path $here 'start-watcher.ps1'
$taskName = 'DSH-Alert-Watcher'

# 计划任务的动作不能直接写 powershell.exe：那样每 15 分钟巡检都会闪一下黑窗
# （-WindowStyle Hidden 挡不住 —— 窗口是先建出来再隐藏的）。改用无控制台的
# run-hidden.exe（/target:winexe 编译，内部 CreateNoWindow），没有就现场编译一份。
# 编译走临时目录的纯 ASCII 路径，避开"中文路径当参数传给子进程会坏掉"的坑。
$launcher = Join-Path $here 'run-hidden.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
    $cs = Join-Path $here 'RunHidden.cs'
    if (Test-Path -LiteralPath $cs) {
        $csc = @(
            (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
            (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
        ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($csc) {
            $tmpCs = Join-Path $env:TEMP 'dsh-alert-RunHidden.cs'
            $tmpExe = Join-Path $env:TEMP 'dsh-alert-run-hidden.exe'
            Copy-Item -LiteralPath $cs -Destination $tmpCs -Force
            & $csc /nologo /target:winexe "/out:$tmpExe" $tmpCs | Out-Null
            if (Test-Path -LiteralPath $tmpExe) { Move-Item -LiteralPath $tmpExe -Destination $launcher -Force }
            Remove-Item -LiteralPath $tmpCs -Force -ErrorAction SilentlyContinue
        }
    }
}

# 动作带 -IfDown：计划任务同时充当"看门狗"。原来只有登录触发器，监测进程一旦被杀
# （例如 2026-09-25 10:20 那次 DSH 重启把它一起带走），就再也不会自己回来，
# 之后所有断网/等待决策的邮件都发不出去。现在每 15 分钟巡检一次，不在跑就拉起。
if (Test-Path -LiteralPath $launcher) {
    $action = New-ScheduledTaskAction -Execute $launcher -Argument 'start-watcher.ps1 -IfDown' -WorkingDirectory $here
} else {
    Write-Output 'WARN: run-hidden.exe 不可用，退回 powershell 方式（每次巡检会闪一下黑窗）'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $start + '" -IfDown')
}
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 365)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($atLogon, $watchdog) -Settings $settings -Principal $principal -Force | Out-Null
$task = Get-ScheduledTask -TaskName $taskName
Write-Output ('task registered: ' + $task.TaskName + ' state=' + $task.State + ' triggers=' + $task.Triggers.Count)
Write-Output ('action: ' + $task.Actions[0].Execute + ' ' + $task.Actions[0].Arguments)
