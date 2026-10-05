# dsh-controller relaunch watchdog.
#
# ASCII-only on purpose, and it must stay that way: a BOM-less .ps1 is read by Windows PowerShell 5.1
# in the system ANSI code page, so non-ASCII text here can break parsing (measured: a UTF-8 Chinese
# comment in a BOM-less script made 5.1 report a stray '}' three lines later).
#
# This is the "delayed script" half of the GUI restart, and it does two things: wait until no process
# of the app is left holding the profile, then start the executable again. The quit itself belongs to
# the application (the plugin drives the tray menu's Exit, which is what the user does by hand); this
# process only picks up the pieces afterwards.
#
# It DOES have one sanctioned escalation, because the measurement demanded it: closing the app's main
# window was observed leaving the process tree alive for 90+ seconds (the quit path can stall), so if
# the tree is still there after KillAfterSeconds this script stops it and only then relaunches. A
# windowless-but-running app is not a restart, and leaving it there strands the user.
#
# Why it must live outside the app: the app is about to exit, so nothing inside it can start it again.

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [int]$WaitSeconds = 120,
  [int]$SettleMs = 2000,
  [int]$ShellPid = 0,
  [int]$KillAfterSeconds = 45
)

$ErrorActionPreference = 'Continue'

function Write-WatchLog([string]$Message) {
  $line = '{0} {1}' -f (Get-Date).ToString('o'), $Message
  try {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $encoding)
  } catch {
    # A log that cannot be written must not stop the relaunch: the relaunch is the point.
  }
}

$exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
Write-WatchLog ("relauncher start exe={0} shellPid={1} wait={2}s settle={3}ms killAfter={4}s" -f $Exe, $ShellPid, $WaitSeconds, $SettleMs, $KillAfterSeconds)

# Wait for the process tree to empty out. This is the one condition that makes starting safe: the app
# holds a profile lock, so a second instance started too early is worse than a late restart.
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$killAt = (Get-Date).AddSeconds($KillAfterSeconds)
$clean = $false
$stopped = $false
while ((Get-Date) -lt $deadline) {
  $alive = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)
  if ($alive.Count -eq 0) { $clean = $true; break }

  # Measured: the app's own quit can stall and leave the window gone with the tree alive (90+ seconds
  # observed). A windowless running app is not a restart, so after the grace period stop it. Every
  # process of this executable belongs to the same app instance (the desktop shell, its Host child and
  # the tool runners all carry this name), so this cannot hit anything else.
  if (-not $stopped -and (Get-Date) -ge $killAt) {
    $stopped = $true
    Write-WatchLog ("{0} process(es) named {1} are still running after {2}s; stopping them so the app can actually restart" -f $alive.Count, $exeName, $KillAfterSeconds)
    foreach ($process in $alive) {
      try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        Write-WatchLog ("  stopped pid {0}" -f $process.Id)
      } catch {
        Write-WatchLog ("  stop pid {0} failed: {1}" -f $process.Id, $_.Exception.Message)
      }
    }
  }

  Start-Sleep -Milliseconds 500
}

if (-not $clean) {
  $left = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue).Count
  Write-WatchLog ("give up: {0} process(es) named {1} are still running after {2}s; not starting a second instance" -f $left, $exeName, $WaitSeconds)
  exit 3
}

Write-WatchLog ("no {0} process left; waiting {1}ms for writers to settle" -f $exeName, $SettleMs)
Start-Sleep -Milliseconds $SettleMs

# Re-check after the settle window: something could have appeared in it (a manual launch, a helper
# that outlived its parent). Starting the app now would be the second instance this guards against.
$appeared = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)
if ($appeared.Count -gt 0) {
  Write-WatchLog ("give up: {0} process(es) named {1} appeared during the settle window; not starting a second instance" -f $appeared.Count, $exeName)
  exit 3
}

try {
  $started = Start-Process -FilePath $Exe -PassThru
  Write-WatchLog ("relaunched: pid {0}" -f $started.Id)
  exit 0
} catch {
  Write-WatchLog ("relaunch failed: {0}" -f $_.Exception.Message)
  exit 4
}
