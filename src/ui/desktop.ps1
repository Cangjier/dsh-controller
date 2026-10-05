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
  [Parameter(Mandatory = $true)][ValidateSet('window', 'look', 'click', 'type', 'key', 'scroll', 'send', 'new-session')][string]$Action,
  [string]$Title,
  [string]$ProcessName = 'DeepSeek Harness',
  [switch]$Focus,
  [string]$Path,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Notches = 1,
  [string]$Text,
  [string]$Chord,
  # new-session: where the "New Session" control sits inside the window, as fractions of its
  # width/height. Measured on the desktop shell: x=11.6% (sidebar button, centred at 150 of a
  # 1296-wide window), y=13.5% (112 of 828). Fractions, not pixels, so a resized window or a
  # different display scale still lands on the button.
  [double]$NewSessionX = 0.116,
  [double]$NewSessionY = 0.135,
  # new-session: where the message composer sits, as fractions of the window. Only used when
  # -Submit is given; the click is what gives the editor keyboard focus.
  [double]$ComposerX = 0.61,
  [double]$ComposerY = 0.565,
  # new-session: the send button, as fractions of the window. The welcome composer's button
  # measures (1119, 484) on a 1296x828 window = .854/.584; the in-conversation composer sits much
  # lower (its button measured at y = 92.8%), which is why every coordinate here is a parameter and
  # not a constant: the two layouts differ by ~36% of the window height.
  [double]$SendButtonX = 0.854,
  [double]$SendButtonY = 0.584,
  # new-session -Submit: where to look for existing ink inside the composer, as percentages of the
  # window, and how many dark pixels mean "there is already text in there". The scan stops at 50%
  # of the width, which is left of every placeholder and control in the card's footer.
  [double]$ComposerInkLeftPercent = 36,
  [double]$ComposerInkTopPercent = 56,
  [int]$ComposerInkMax = 8,
  # new-session: deliver -Text into the new session's composer and press Enter. Without it the
  # action stops after the session is on screen, which is the operation the host verifies.
  [switch]$Submit,
  # new-session: how long to give the shell after the click before looking for the composer.
  [int]$SettleMs = 1200,
  # new-session: opt out of the clipboard guard by consuming a base64 payload in -Text.
  [switch]$TextIsBase64
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

# A full INPUT union, because Windows checks cbSize against sizeof(INPUT) and rejects anything
# smaller with ERROR_INVALID_PARAMETER (87). Declaring only the KEYBDINPUT member marshals to
# 32 bytes and silently fails; with MOUSEINPUT present it is the 40 bytes Windows expects.
# Measured the hard way: the 32-byte version returns 0 from SendInput and types nothing.
if (-not ('DshInput' -as [type])) {
  Add-Type -Namespace DshInput -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
[StructLayout(LayoutKind.Explicit)] public struct InputUnion {
  [FieldOffset(0)] public MOUSEINPUT mi;
  [FieldOffset(0)] public KEYBDINPUT ki;
  [FieldOffset(0)] public HARDWAREINPUT hi;
}
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
[DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
'@
}

# The DSH composer is a Lexical editor: clipboard paste (^v via SendKeys) does not reach it,
# and a Unicode SendInput is the delivery path that carries CJK. Both are tried for -Submit.
$INPUT_KEYBOARD = 1
$KEYEVENTF_KEYUP = 0x0002
$KEYEVENTF_UNICODE = 0x0004
$VK_CONTROL = 0x11
$VK_A = 0x41
$VK_C = 0x43
$VK_V = 0x56
$INPUT_SIZE = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DshInput.Native+INPUT])

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
  # Non-ASCII does not travel through SendKeys. Send it with a Unicode SendInput: it bypasses
  # the layout and the IME, and goes to whatever holds keyboard focus.
  $injected = Send-UnicodeText $value
  if ($injected.ok) { return @{ ok = $true; method = 'sendinput-unicode'; sentChars = $injected.sentChars } }
  # Last resort: put it on the clipboard and send the native paste chord. This only works where
  # the editor reads the clipboard itself, so the result says which path was used.
  $previous = $null
  try { $previous = [System.Windows.Forms.Clipboard]::GetText() } catch { $previous = $null }
  [System.Windows.Forms.Clipboard]::SetText($value)
  Start-Sleep -Milliseconds 80
  [void](Send-VirtualChord $VK_CONTROL $VK_V)
  Start-Sleep -Milliseconds 120
  return @{ ok = $true; method = 'clipboard-paste'; clipboardOverwritten = $true; clipboardRestored = $false; previousLength = if ($null -eq $previous) { 0 } else { $previous.Length }; sendInputError = $injected.error }
}

# One Unicode character is one KEYBDINPUT pair at the scan-code slot. Returns how many landed.
function Send-UnicodeText([string]$value) {
  $sent = 0
  $failure = $null
  foreach ($char in $value.ToCharArray()) {
    $code = [uint16][char]$char
    $down = New-KeyInput $code $KEYEVENTF_UNICODE
    $up = New-KeyInput $code ($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)
    $batch = @($down, $up)
    $count = [DshInput.Native]::SendInput(2, $batch, $INPUT_SIZE)
    if ($count -eq 2) { $sent++ }
    elseif ($null -eq $failure) { $failure = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    Start-Sleep -Milliseconds 12
  }
  return @{ ok = ($sent -eq $value.Length -and $value.Length -gt 0); sentChars = $sent; error = $failure }
}

# A modifier chord through SendInput, so it does not depend on SendKeys' escaping rules.
function Send-VirtualChord([int]$modifier, [int]$key) {
  $inputs = @(
    (New-VirtualKeyInput $modifier $false),
    (New-VirtualKeyInput $key $false),
    (New-VirtualKeyInput $key $true),
    (New-VirtualKeyInput $modifier $true)
  )
  return [DshInput.Native]::SendInput(4, $inputs, $INPUT_SIZE)
}

function New-KeyInput([uint16]$scan, [uint32]$flags) {
  $input = New-Object DshInput.Native+INPUT
  $input.type = $INPUT_KEYBOARD
  $input.U.ki.wVk = 0
  $input.U.ki.wScan = $scan
  $input.U.ki.dwFlags = $flags
  $input.U.ki.time = 0
  $input.U.ki.dwExtraInfo = [System.IntPtr]::Zero
  return $input
}

function New-VirtualKeyInput([int]$key, [bool]$up) {
  $flags = if ($up) { $KEYEVENTF_KEYUP } else { 0 }
  $input = New-Object DshInput.Native+INPUT
  $input.type = $INPUT_KEYBOARD
  $input.U.ki.wVk = [uint16]$key
  $input.U.ki.wScan = 0
  $input.U.ki.dwFlags = [uint32]$flags
  $input.U.ki.time = 0
  $input.U.ki.dwExtraInfo = [System.IntPtr]::Zero
  return $input
}

# Is there text in the composer already? A new session is supposed to open an empty composer, but
# the shell keeps an unsent draft alive in the sidebar: after the click the old draft can still be
# the one on screen, and SendKeys would then append this message to it. So the region just inside
# the card's left padding is read back and counted before anything is typed. This is the one place
# this script looks at pixels, and it only distinguishes "empty" from "has something".
function Measure-ComposerInk($target, [int]$LeftFraction, [int]$TopFraction) {
  $rect = $target.rect
  $bitmap = New-Object System.Drawing.Bitmap $rect.width, $rect.height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.left, $rect.top, 0, 0, $bitmap.Size)
  $x0 = [int]($rect.width * ($LeftFraction / 100.0))
  $x1 = [int]($rect.width * 0.50)
  $y0 = [int]($rect.height * ($TopFraction / 100.0))
  $y1 = $y0 + 14
  $ink = 0
  for ($y = $y0; $y -lt $y1; $y++) {
    for ($x = $x0; $x -lt $x1; $x++) {
      $pixel = $bitmap.GetPixel($x, $y)
      if (($pixel.R + $pixel.G + $pixel.B) -lt 550) { $ink++ }
    }
  }
  $graphics.Dispose()
  $bitmap.Dispose()
  return @{ ink = $ink; x0 = $x0; x1 = $x1; y0 = $y0; y1 = $y1 }
}

# Click the send button at the composer's trailing edge. Measured, not derived from the shell's
# internals: on a 1296x828 window the button centre is (1114, 768), i.e. 86% across and 92.8% down.
# `{ENTER}` was tried first and left the text sitting in the composer, so this is the submit that
# actually works.
function Click-SendButton($target) {
  $rect = $target.rect
  $originX = [System.Windows.Forms.Cursor]::Position.X
  $originY = [System.Windows.Forms.Cursor]::Position.Y
  $screenX = $rect.left + [int][Math]::Round($rect.width * $SendButtonX)
  $screenY = $rect.top + [int][Math]::Round($rect.height * $SendButtonY)
  [void][DshWin32.Native]::SetCursorPos($screenX, $screenY)
  Start-Sleep -Milliseconds 60
  [DshWin32.Native]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [DshWin32.Native]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 350
  [void][DshWin32.Native]::SetCursorPos($originX, $originY)
  return @{ sendButtonX = $screenX; sendButtonY = $screenY; sendButtonRelativeX = [int][Math]::Round($rect.width * $SendButtonX); sendButtonRelativeY = [int][Math]::Round($rect.height * $SendButtonY) }
}

# Click the DSH "New Session" control. Same guard rails as the plain click action: the window
# must be in front first, and the pointer is put back where it was, because this is a real
# machine and the user's mouse is not ours to move.
function Click-NewSession($target, [int]$SettleMs) {
  if (-not (Focus-Target $target 120)) { return @{ ok = $false; reason = 'not-foreground' } }
  $rect = $target.rect
  $originX = [System.Windows.Forms.Cursor]::Position.X
  $originY = [System.Windows.Forms.Cursor]::Position.Y
  $screenX = $rect.left + [int][Math]::Round($rect.width * $NewSessionX)
  $screenY = $rect.top + [int][Math]::Round($rect.height * $NewSessionY)
  [void][DshWin32.Native]::SetCursorPos($screenX, $screenY)
  Start-Sleep -Milliseconds 50
  [DshWin32.Native]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [DshWin32.Native]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds $SettleMs
  [void][DshWin32.Native]::SetCursorPos($originX, $originY)
  return @{
    ok             = $true
    newSessionX    = $screenX
    newSessionY    = $screenY
    relativeX      = [int][Math]::Round($rect.width * $NewSessionX)
    relativeY      = [int][Math]::Round($rect.height * $NewSessionY)
    pointerRestored = $true
  }
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

  if ($Action -eq 'send') {
    # A separate step on purpose: the composer content can be looked at between the typing and the
    # submit, which is the only way to tell "the text landed" from "the send button got clicked".
    if (-not (Focus-Target $target 120)) { return @{ ok = $false; reason = 'not-foreground'; target = $target } }
    $sent = Click-SendButton $target
    return (@{ ok = $true; transport = 'ui'; target = $target } + $sent)
  }

  if ($Action -eq 'new-session') {
    if ($TextIsBase64) {
      try { $Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Text)) }
      catch { return @{ ok = $false; reason = 'bad-base64-text'; message = $_.Exception.Message } }
    }
    $clicked = Click-NewSession $target $SettleMs
    if (-not $clicked.ok) {
      return @{ ok = $false; reason = $clicked.reason; transport = 'ui'; target = $target }
    }

    # One hashtable built in place: `+` on two hashtables throws on a duplicate key, and `ok`
    # appears in both halves.
    $result = @{
      ok              = $true
      transport       = 'ui'
      clicked         = $true
      submit          = [bool]$Submit
      textLength      = if ($Text) { $Text.Length } else { 0 }
      newSessionX     = $clicked.newSessionX
      newSessionY     = $clicked.newSessionY
      relativeX       = $clicked.relativeX
      relativeY       = $clicked.relativeY
      pointerRestored = $clicked.pointerRestored
      target          = $target
    }

    if (-not $Submit) { return $result }

    # `ok` means "the caller may trust this session to carry `-Text`". Everything below that can
    # fail has to clear it, or the host will treat a refused submit as a delivered message.
    $result.ok = $false

    if (-not $Text) { $result.reason = 'text-required'; return $result }

    # The composer is a Lexical editor, and two input paths were measured on this build:
    #   - SendKeys for ASCII text: lands, every time.
    #   - SendKeys '^v' after putting the text on the clipboard: reports ok, the editor stays empty.
    #   - a Unicode SendInput for CJK: Windows accepts it (SendInput returns 2 per character) and
    #     not one character appears in the composer.
    # So this action refuses non-ASCII rather than reporting a success that did not happen. The
    # caller falls back to the API to deliver the message; the session stays either way.
    if ($Text -notmatch '^[\x20-\x7E]*$') {
      $result.reason = 'text-not-ascii'
      $result.hint = 'the DSH composer accepts injected ASCII only; deliver non-ASCII text through the API'
      return $result
    }

    # The composer is focused by clicking it, not by hoping: right after the click the shell may
    # still be swapping the empty state for the conversation area.
    $composerX = $target.rect.left + [int][Math]::Round($target.rect.width * $ComposerX)
    $composerY = $target.rect.top + [int][Math]::Round($target.rect.height * $ComposerY)
    [void][DshWin32.Native]::SetCursorPos($composerX, $composerY)
    Start-Sleep -Milliseconds 50
    [DshWin32.Native]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [DshWin32.Native]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250

    $escaped = $Text -replace '([+^%~(){}\[\]])', '{$1}'
    $ink = Measure-ComposerInk $target $ComposerInkLeftPercent $ComposerInkTopPercent
    $result.composerInk = $ink.ink
    if ($ink.ink -gt $ComposerInkMax) {
      # 输入框里本来就有字（多半是侧边栏里还留着一条没发出去的草稿）。这时候再敲字就是把它
      # 接到别人的话后面，所以这里停手，让调用方改用 API 投递。
      $result.reason = 'composer-not-empty'
      $result.hint = 'the compose box already holds an unsent draft; deliver this message through the API instead'
      return $result
    }
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    Start-Sleep -Milliseconds 250
    $sent = Click-SendButton $target

    $result.composerX = $composerX
    $result.composerY = $composerY
    $result.method = 'sendkeys'
    $result.sentChars = $Text.Length
    $result.submitted = $true
    $result.ok = $true
    foreach ($key in $sent.Keys) { $result[$key] = $sent[$key] }
    return $result
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
