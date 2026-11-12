# Turns words you added in the reader into cards, generates missing cloze sentences (at most 120 words a run,
# one batch at a time), keeps the reader's glossary and sentence translations 30 pages ahead, adds alternatives,
# and pushes it all to french-data (the phone gets them on its next load or sync).
#
#   powershell -File tools\sentences_task.ps1 -Register     # once: Windows task, daily at 13:00, at logon and on wake
#   powershell -File tools\sentences_task.ps1               # run (what the task runs; skipped if a run began < 2 h ago)
#   powershell -File tools\sentences_task.ps1 -Force        # run now, even if a run began < 2 h ago
#   powershell -File tools\sentences_task.ps1 -Unregister
#
# Runs only while you are logged on (claude -p uses your Claude Code login). A missed run (laptop off or asleep)
# starts as soon as the laptop is available again. Waking from sleep (Modern Standby, Kernel-Power 507) also
# starts a run after 5 min; wakes come in bursts, so a run that began less than 2 h ago makes the next one skip. Nothing to do -> exits within seconds.
# Log: ..\french-data\imports\logs\sentences.log (local, not in git).
param([switch]$Register, [switch]$Unregister, [switch]$Force)

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
    # on wake from Modern Standby (no logon happens then)
    $wake = New-CimInstance -ClientOnly -CimClass (Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger)
    $wake.Enabled = $true
    $wake.Delay = "PT5M"
    $wake.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Kernel-Power''] and EventID=507]]</Select></Query></QueryList>'
    $triggers += $wake
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6) -RunOnlyIfNetworkAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
        -Description "Missing French Trainer sentences (tools/make_sentences.py --push, Sonnet)" -Force | Out-Null
    "registered: $TaskName (daily 13:00, at logon and on wake; missed runs start when available)"
    return
}

$logDir = Join-Path $Data "imports\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "sentences.log"
$stamp = Join-Path $logDir "last_start.txt"
if (-not $Force -and (Test-Path $stamp)) {
    $last = [datetime]::Parse((Get-Content $stamp -Raw).Trim())
    if ((Get-Date) - $last -lt (New-TimeSpan -Hours 2)) {
        "$(Get-Date -Format s) skipped (last run began $($last.ToString('s')))" | Out-File $log -Append -Encoding utf8
        exit 0
    }
}
Get-Date -Format s | Out-File $stamp -Encoding ascii
$env:PYTHONIOENCODING = "utf-8"
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { "$(Get-Date -Format s) python not found" | Out-File $log -Append -Encoding utf8; exit 1 }
"--- $(Get-Date -Format s) start" | Out-File $log -Append -Encoding utf8
& git -C $Data pull -q --ff-only 2>&1 | Out-File $log -Append -Encoding utf8
& $py (Join-Path $Tools "add_words.py") --tapped-only --no-sentences --push 2>&1 | Out-File $log -Append -Encoding utf8
& $py (Join-Path $Tools "make_sentences.py") --limit 120 --push 2>&1 | Out-File $log -Append -Encoding utf8
# reader: glossary + sentence translations 30 pages past your position in the books you are reading
& $py (Join-Path $Tools "import_book.py") --ahead 30 --push 2>&1 | Out-File $log -Append -Encoding utf8
# alternatives (other words that are also right in the gap) for sentences made before they existed
& $py (Join-Path $Tools "make_sentences.py") --alts --limit 400 --push 2>&1 | Out-File $log -Append -Encoding utf8
"--- $(Get-Date -Format s) end" | Out-File $log -Append -Encoding utf8
