# dsh-controller UI fallback: real window input for the DSH desktop app.
#
# This is the LAST transport, used only when neither the in-process cordis API nor the
# `dsh` CLI can do the job. It is deliberately ASCII-only: Windows PowerShell 5.1 reads a
# BOM-less script in the system ANSI code page, so any non-ASCII literal here would be
# mangled on a Chinese machine. All Chinese lives in the JavaScript.
#
# Every action prints exactly one line of compact JSON on stdout and exits 0; a failure is
# a JSON object with ok=false, because a non-zero exit would make the caller parse stderr.
#
# The guard rail is the point of the input actions: the target window is focused and the
# focus is READ BACK before any key or click is sent. If the window did not come forward,
# nothing is sent and the result says so. Synthetic input that lands nowhere still
# "succeeds", so the only trustworthy evidence is the foreground check.
param(
  [Parameter(Mandatory = $true)][ValidateSet('window', 'look', 'click', 'type', 'key', 'scroll')][string]$Action,
  [string]$Title,
  [string]$ProcessName = 'DeepSeek Harness',
  [switch]$Focus,
  [string]$Path,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Notches = 1,
  [string]$Text,
  [string]$Chord
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('DshWin32' -as [type])) {
  Add-Type -Namespace DshWin32 -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
'@
}

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_WHEEL = 0x0800
$WHEEL_DELTA = 120

function Get-WindowText([IntPtr]$handle) {
  $buffer = New-Object System.Text.StringBuilder 512
  [void][DshWin32.Native]::GetWindowTextW($handle, $buffer, $buffer.Capacity)
  return $buffer.ToString()
}

function Get-Rect([IntPtr]$handle) {
  $rect = New-Object DshWin32.Native+RECT
  [void][DshWin32.Native]::GetWindowRect($handle, [ref]$rect)
  return @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
}

# Every visible top-level window, with the owning process name resolved once per pid.
function Get-Candidates {
  $list = New-Object System.Collections.ArrayList
  $cache = @{}
  $foreground = [DshWin32.Native]::GetForegroundWindow()
  foreach ($process in [System.Diagnostics.Process]::GetProcesses()) {
    if ($process.MainWindowHandle -eq 0) { continue }
    $handle = $process.MainWindowHandle
    try {
      if (-not [DshWin32.Native]::IsWindowVisible($handle)) { continue }
      $windowTitle = Get-WindowText $handle
    } catch { continue }
    if (-not $cache.ContainsKey($process.Id)) { $cache[$process.Id] = $process.ProcessName }
    [void]$list.Add([pscustomobject]@{
      handle     = [int64]$handle
      title      = $windowTitle
      process    = $cache[$process.Id]
      processId  = $process.Id
      rect       = Get-Rect $handle
      background = ($handle -ne $foreground)
    })
  }
  return $list
}

# Pick the DSH window: an explicit title substring wins; otherwise the configured process
# name. Among several, the foreground one is preferred, then the largest by area.
function Select-Target($candidates) {
  $filtered = @()
  if ($Title) {
    $filtered = @($candidates | Where-Object { $_.title -like "*$Title*" })
  }
  if ($filtered.Count -eq 0) {
    $filtered = @($candidates | Where-Object { $_.process -eq $ProcessName })
  }
  if ($filtered.Count -eq 0) { return $null }
  $front = @($filtered | Where-Object { -not $_.background })
  if ($front.Count -gt 0) { return $front[0] }
  return @($filtered | Sort-Object -Property @{ Expression = { $_.rect.width * $_.rect.height } } -Descending)[0]
}

# Bring the window forward and READ THE FOCUS BACK. Returns $true only when it worked.
function Focus-Target($target, [int]$SettleMs) {
  [void][DshWin32.Native]::ShowWindow([IntPtr]$target.handle, 9)
  [void][DshWin32.Native]::SetForegroundWindow([IntPtr]$target.handle)
  Start-Sleep -Milliseconds $SettleMs
  return ([DshWin32.Native]::GetForegroundWindow() -eq [IntPtr]$target.handle)
}

function Send-TextTo($target, [string]$value, [int]$SettleMs) {
  if (-not (Focus-Target $target $SettleMs)) { return @{ ok = $false; reason = 'not-foreground' } }
  $ascii = ($value -match '^[\x20-\x7E\r\n\t]*$')
  if ($ascii) {
    # SendKeys treats these as syntax, so an ASCII body still has to be escaped.
    $escaped = $value -replace '([+^%~(){}\[\]])', '{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    return @{ ok = $true; method = 'sendkeys' }
  }
  # Non-ASCII (Chinese, emoji) does not travel through SendKeys: paste it instead. This
  # overwrites the clipboard, which the caller is told about.
  $previous = $null
  try { $previous = [System.Windows.Forms.Clipboard]::GetText() } catch { $previous = $null }
  [System.Windows.Forms.Clipboard]::SetText($value)
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 60
  return @{ ok = $true; method = 'clipboard'; clipboardOverwritten = $true; clipboardRestored = $false; previousLength = if ($null -eq $previous) { 0 } else { $previous.Length } }
}

function Invoke-Action {
  $candidates = Get-Candidates

  if ($Action -eq 'window') {
    $target = Select-Target $candidates
    $focused = $false
    if ($null -ne $target -and $Focus) { $focused = Focus-Target $target 120 }
    return @{
      ok         = ($null -ne $target)
      transport  = 'ui'
      focused    = $focused
      target     = $target
      matches    = @($candidates | Where-Object { $_.process -eq $ProcessName -or ($Title -and $_.title -like "*$Title*") } | Select-Object handle, title, process, processId, background, rect)
      candidates = $candidates.Count
    }
  }

  $target = Select-Target $candidates
  if ($null -eq $target) {
    return @{ ok = $false; reason = 'window-not-found'; processName = $ProcessName; title = $Title; candidates = $candidates.Count }
  }

  if ($Action -eq 'look') {
    $rect = $target.rect
    if ($rect.width -le 0 -or $rect.height -le 0) { return @{ ok = $false; reason = 'empty-rect'; target = $target } }
    $bitmap = New-Object System.Drawing.Bitmap $rect.width, $rect.height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($rect.left, $rect.top, 0, 0, $bitmap.Size)
    if (-not $Path) { return @{ ok = $false; reason = 'path-required' } }
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path $directory)) { [void](New-Item -ItemType Directory -Force -Path $directory) }
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
    return @{ ok = $true; transport = 'ui'; path = $Path; width = $rect.width; height = $rect.height; rect = $rect; target = $target }
  }

  if ($Action -eq 'click') {
    $screenX = $target.rect.left + $X
    $screenY = $target.rect.top + $Y
    if (-not (Focus-Target $target 120)) { return @{ ok = $false; reason = 'not-foreground'; target = $target } }
    [void][DshWin32.Native]::SetCursorPos($screenX, $screenY)
    Start-Sleep -Milliseconds 40
    [DshWin32.Native]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 30
    [DshWin32.Native]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [System.UIntPtr]::Zero)
    return @{ ok = $true; transport = 'ui'; screenX = $screenX; screenY = $screenY; relativeX = $X; relativeY = $Y; target = $target; verifiedForeground = $true }
  }

  if ($Action -eq 'type') {
    if (-not $Text) { return @{ ok = $false; reason = 'text-required' } }
    $sent = Send-TextTo $target $Text 120
    return ($sent + @{ transport = 'ui'; target = $target; length = $Text.Length })
  }

  if ($Action -eq 'key') {
    if (-not $Chord) { return @{ ok = $false; reason = 'chord-required' } }
    if (-not (Focus-Target $target 120)) { return @{ ok = $false; reason = 'not-foreground'; target = $target } }
    [System.Windows.Forms.SendKeys]::SendWait($Chord)
    return @{ ok = $true; transport = 'ui'; chord = $Chord; target = $target; verifiedForeground = $true }
  }

  if ($Action -eq 'scroll') {
    if (-not (Focus-Target $target 120)) { return @{ ok = $false; reason = 'not-foreground'; target = $target } }
    [void][DshWin32.Native]::SetCursorPos(($target.rect.left + $X), ($target.rect.top + $Y))
    Start-Sleep -Milliseconds 40
    for ($index = 0; $index -lt [Math]::Abs($Notches); $index++) {
      $delta = if ($Notches -gt 0) { $WHEEL_DELTA } else { -$WHEEL_DELTA }
      [DshWin32.Native]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, $delta, [System.UIntPtr]::Zero)
    }
    return @{ ok = $true; transport = 'ui'; notches = $Notches; target = $target; verifiedForeground = $true }
  }

  return @{ ok = $false; reason = 'unhandled-action' }
}

try {
  $result = Invoke-Action
  Write-Output ($result | ConvertTo-Json -Compress -Depth 6)
} catch {
  $failure = @{ ok = $false; reason = 'script-error'; message = $_.Exception.Message }
  Write-Output ($failure | ConvertTo-Json -Compress -Depth 4)
}
