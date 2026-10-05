# dsh-controller restart watchdog.
#
# ASCII-only on purpose, and it must stay that way: a BOM-less .ps1 is read by Windows PowerShell 5.1
# in the system ANSI code page, so non-ASCII text here can break parsing (measured: a UTF-8 Chinese
# comment in a BOM-less script made 5.1 report a stray '}' three lines later).
#
# This process is deliberately OUTSIDE the DSH process tree: it is spawned detached, it outlives the
# app, and it does exactly one thing -- wait for the app's main process to disappear, then start the
# executable again. It never starts a second instance: if the main process is still alive when the
# deadline passes, it gives up and says so instead of racing the running app for the profile lock.

param(
  [Parameter(Mandatory = $true)][int]$MainPid,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [int]$TimeoutSeconds = 180,
  [int]$SettleMs = 1500,
  [int]$ChildLingerSeconds = 15
)

$ErrorActionPreference = 'Continue'

function Write-WatchLog([string]$Message) {
  $line = '{0} {1}' -f (Get-Date).ToString('o'), $Message
  try {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $encoding)
  } catch {
    # A log that cannot be written must not stop the restart: the restart is the point.
  }
}

$exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
Write-WatchLog ("watchdog start mainPid={0} exe={1} timeout={2}s settle={3}ms" -f $MainPid, $Exe, $TimeoutSeconds, $SettleMs)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$exited = $false
while ((Get-Date) -lt $deadline) {
  $process = Get-Process -Id $MainPid -ErrorAction SilentlyContinue
  if ($null -eq $process) { $exited = $true; break }
  Start-Sleep -Milliseconds 300
}

if (-not $exited) {
  Write-WatchLog ("give up: pid {0} is still alive after {1}s; not starting a second instance" -f $MainPid, $TimeoutSeconds)
  exit 3
}

Write-WatchLog ("main pid {0} is gone; waiting {1}ms for writers to settle" -f $MainPid, $SettleMs)
Start-Sleep -Milliseconds $SettleMs

# Do not race a lingering child: Electron's helper processes normally die with the main process, but
# starting the app while one of them still holds the profile is exactly the failure this avoids.
$lingerDeadline = (Get-Date).AddSeconds($ChildLingerSeconds)
while ((Get-Date) -lt $lingerDeadline) {
  $left = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)
  if ($left.Count -eq 0) { break }
  Write-WatchLog ("waiting for {0} leftover process(es) of {1}" -f $left.Count, $exeName)
  Start-Sleep -Milliseconds 500
}
$left = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)
if ($left.Count -gt 0) {
  Write-WatchLog ("give up: {0} process(es) named {1} are still running; not starting a second instance" -f $left.Count, $exeName)
  exit 5
}

try {
  $started = Start-Process -FilePath $Exe -PassThru
  Write-WatchLog ("relaunched: pid {0}" -f $started.Id)
  exit 0
} catch {
  Write-WatchLog ("relaunch failed: {0}" -f $_.Exception.Message)
  exit 4
}
