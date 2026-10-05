# dsh-controller restart watchdog.
#
# ASCII-only on purpose, and it must stay that way: a BOM-less .ps1 is read by Windows PowerShell 5.1
# in the system ANSI code page, so non-ASCII text here can break parsing (measured: a UTF-8 Chinese
# comment in a BOM-less script made 5.1 report a stray '}' three lines later).
#
# This process is deliberately OUTSIDE the DSH process tree: it is spawned detached, it outlives the
# app, and it does one thing -- wait for the Host to disappear, make sure nothing is left holding the
# profile, then start the executable again.
#
# WHY THERE ARE TWO PIDS (this is the part that was wrong once):
#   -HostPid  is the DSH Host child process: the one running the plugin, and the one `ctx.appExit(0)`
#             actually shuts down. Measured in the launcher source (apps/cli/src/profile-boot.ts):
#             `exit: code => void shutdown.shutdown(code)` -- it is the Host's own teardown, NOT a
#             request to quit the desktop application.
#   -ShellPid is the Electron main process (the desktop app itself). It does NOT exit when its Host
#             dies; it is left with no backend at all, which is the "reconnecting" screen.
# So: wait for the Host, then deal with the shell (ask it to close, force it if it will not), and only
# then start the app again. Never start a second instance: if anything is still alive at a deadline,
# give up and say so instead of racing the running app for the profile lock.

param(
  [int]$MainPid = 0,
  [int]$ShellPid = 0,
  [int]$HostPid = 0,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [int]$TimeoutSeconds = 180,
  [int]$SettleMs = 1500,
  [int]$ShellGraceSeconds = 8,
  [int]$ChildLingerSeconds = 15,
  [int]$ForceKillSeconds = 10
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

function Test-Alive([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# -MainPid is the OLD name for the shell pid: an older Node build passed it as "the main process".
if ($ShellPid -le 0) { $ShellPid = $MainPid }

$exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
Write-WatchLog ("watchdog start shellPid={0} hostPid={1} exe={2} timeout={3}s settle={4}ms shellGrace={5}s" -f $ShellPid, $HostPid, $Exe, $TimeoutSeconds, $SettleMs, $ShellGraceSeconds)

# If the launcher did not say which child is the Host, find it: the Host is the shell's child whose
# command line carries --expose-internals. That keeps this script correct even when an older Node
# build spawned it with only one pid.
if ($HostPid -le 0 -and $ShellPid -gt 0) {
  try {
    $candidate = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ShellPid" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*--expose-internals*' } |
      Select-Object -First 1
    if ($null -ne $candidate) {
      $HostPid = [int]$candidate.ProcessId
      Write-WatchLog ("discovered host pid {0} under shell {1}" -f $HostPid, $ShellPid)
    }
  } catch {
    Write-WatchLog ("host discovery failed: {0}" -f $_.Exception.Message)
  }
}

# Without a Host pid there is nothing to wait for that means "the Host shut down", so fall back to
# waiting for the shell: that is the old, stricter behaviour, and it refuses rather than guesses.
$waitFor = $HostPid
$waitLabel = 'host'
if ($waitFor -le 0) {
  $waitFor = $ShellPid
  $waitLabel = 'shell (host pid unknown)'
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$exited = $false
while ((Get-Date) -lt $deadline) {
  if (-not (Test-Alive $waitFor)) { $exited = $true; break }
  Start-Sleep -Milliseconds 300
}

if (-not $exited) {
  Write-WatchLog ("give up: {0} pid {1} is still alive after {2}s; not starting a second instance" -f $waitLabel, $waitFor, $TimeoutSeconds)
  exit 3
}

Write-WatchLog ("{0} pid {1} is gone; waiting {2}ms for writers to settle" -f $waitLabel, $waitFor, $SettleMs)
Start-Sleep -Milliseconds $SettleMs

# The shell outlives its Host. Ask it to close the way a user would (WM_CLOSE on its main window);
# if it will not go -- the app can hide instead of quitting, and a Host failure may raise a recovery
# dialog -- force it. Leaving it alive is not an option: it owns the profile, so starting the app
# now would race it.
if (Test-Alive $ShellPid) {
  $closed = $false
  try {
    $shellProcess = Get-Process -Id $ShellPid -ErrorAction Stop
    if ($shellProcess.MainWindowHandle -ne 0) {
      $null = $shellProcess.CloseMainWindow()
      Write-WatchLog ("asked shell pid {0} to close its main window" -f $ShellPid)
    } else {
      Write-WatchLog ("shell pid {0} has no main window to close" -f $ShellPid)
    }
  } catch {
    Write-WatchLog ("close request for shell pid {0} failed: {1}" -f $ShellPid, $_.Exception.Message)
  }

  $graceDeadline = (Get-Date).AddSeconds($ShellGraceSeconds)
  while ((Get-Date) -lt $graceDeadline) {
    if (-not (Test-Alive $ShellPid)) { $closed = $true; break }
    Start-Sleep -Milliseconds 300
  }

  if ($closed) {
    Write-WatchLog ("shell pid {0} exited on its own" -f $ShellPid)
  } else {
    Write-WatchLog ("shell pid {0} did not exit within {1}s; terminating it" -f $ShellPid, $ShellGraceSeconds)
    try {
      Stop-Process -Id $ShellPid -Force -ErrorAction Stop
    } catch {
      Write-WatchLog ("terminate shell pid {0} failed: {1}" -f $ShellPid, $_.Exception.Message)
    }
    $killDeadline = (Get-Date).AddSeconds($ForceKillSeconds)
    while ((Get-Date) -lt $killDeadline) {
      if (-not (Test-Alive $ShellPid)) { break }
      Start-Sleep -Milliseconds 300
    }
    if (Test-Alive $ShellPid) {
      Write-WatchLog ("give up: shell pid {0} is still alive after termination; not starting a second instance" -f $ShellPid)
      exit 5
    }
    Write-WatchLog ("shell pid {0} is gone" -f $ShellPid)
  }
}

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
