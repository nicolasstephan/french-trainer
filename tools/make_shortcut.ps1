# Creates (or refreshes) the "French Trainer" desktop shortcut: the live site in Chrome (where the app's sync
# settings live since 2026-11-03; they are per browser), with the hub icon (FR-01, black mark + thin white outline).
# Without Chrome it opens in the default browser. Re-run after moving the project folder.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$url = "https://nicolasstephan.github.io/french-trainer/"
$icon = Join-Path $root "icons\icon-outline.ico"

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "French Trainer.lnk"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
if ($chrome) {
    $s.TargetPath = $chrome
    $s.Arguments = $url   # a tab in the open Chrome window, not a new window (Nicolas, 2026-11-03)
} else {
    $s.TargetPath = $url
    $s.Arguments = ""
}
$s.IconLocation = $icon
$s.Description = "French Trainer: vocabulary in context"
$s.Save()
Write-Host "Shortcut created: $lnk" -ForegroundColor Green
