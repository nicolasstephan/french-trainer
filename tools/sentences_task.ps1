# Generates missing cloze sentences in the background and pushes them to french-data (the phone gets them on its next load).
#
#   powershell -File tools\sentences_task.ps1 -Register     # once: Windows task, daily at 13:00 and at every logon
#   powershell -File tools\sentences_task.ps1               # run now (what the task runs)
#   powershell -File tools\sentences_task.ps1 -Unregister
#
# Runs only while you are logged on (claude -p uses your Claude Code login). A missed run (laptop off or asleep)
# starts as soon as the laptop is available again. Nothing to do -> exits within seconds.
# Log: ..\french-data\imports\logs\sentences.log (local, not in git).
param([switch]$Register, [switch]$Unregister)

$TaskName = "French Trainer sentences"
$Tools = $PSScriptRoot
$Data = Join-Path (Split-Path (Split-Path $Tools)) "french-data"

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "removed: $TaskName"
    return
}

if ($Register) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -WorkingDirectory (Split-Path $Tools)
    $triggers = @((New-ScheduledTaskTrigger -Daily -At 13:00), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
    $triggers[1].Delay = "PT5M"   # after logon, once the network is up
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6) -RunOnlyIfNetworkAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
        -Description "Missing French Trainer sentences (tools/make_sentences.py --push, Sonnet)" -Force | Out-Null
    "registered: $TaskName (daily 13:00 and at logon; missed runs start when available)"
    return
}

$logDir = Join-Path $Data "imports\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "sentences.log"
$env:PYTHONIOENCODING = "utf-8"
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { "$(Get-Date -Format s) python not found" | Out-File $log -Append -Encoding utf8; exit 1 }
"--- $(Get-Date -Format s) start" | Out-File $log -Append -Encoding utf8
& git -C $Data pull -q --ff-only 2>&1 | Out-File $log -Append -Encoding utf8
& $py (Join-Path $Tools "make_sentences.py") --push 2>&1 | Out-File $log -Append -Encoding utf8
"--- $(Get-Date -Format s) end" | Out-File $log -Append -Encoding utf8
