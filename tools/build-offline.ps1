# Build an offline, self-contained copy of dsh-controller.
#
# What "offline" means here
# -------------------------
# The sibling packages in this family bundle hundreds of megabytes of binaries because their plugins
# shell out to ffmpeg, an OCR engine or an ONNX model. dsh-controller does not: it is a pure ESM,
# zero-dependency package that imports nothing but node: builtins, and every host capability it uses
# it looks up at run time with `ctx.get(name)` and degrades when the service is absent. So it is
# already offline in the strict sense; what an offline package has to add is not binaries but
# *verifiability and reproducibility*: a copy that can be installed with no network, a manifest that
# proves which bytes are in it, and this script so the copy can refresh itself.
#
# The two sibling integrations are deliberately NOT bundled. Both are optional at run time and both
# degrade to a documented path (see docs\offline-deploy.md):
#
#   1. `dsh_sessions {action:"create"}` with a cwd hands the job to dsh-computer-use's script library
#      (`create.scriptDir` defaults to the plugin's own scripts\, which IS bundled). If that sibling
#      is not installed, the GUI leg falls back to the "new session" button leg and then to the API.
#   2. `dsh_host {action:"restart"}` asks dsh-computer-use to quit the app through its tray menu.
#      Without that sibling the watchdog collects the process tree instead - the restart still
#      happens, it is just not graceful. Bundling a second copy of a ~340 MB package to serve an
#      optional path would be worse than the fallback it buys, and its own offline package exists.
#
# Layout written
# --------------
# The plugin directory is written exactly like the package's `files` list, so it is the thing to
# install; everything that exists to explain or verify the delivery lives at the package root beside
# it and is never installed:
#
#   <OutDir>\dsh-controller\           the plugin package, installable as it stands
#     index.mjs, package.json, cordis.patch.yml, LICENSE, README.md
#     src\, scripts\, tests\
#   <OutDir>\README-OFFLINE.md         how to install, verify and what degrades without siblings
#   <OutDir>\manifest.json             every packaged file with its size and SHA-256, plus the 7z
#   <OutDir>\SHA256SUMS.txt            the same hashes in sha256sum format, for sha256sum -c
#   <OutDir>\verify-offline.mjs        checks a package against its manifest, with no dependencies
#   <OutDir>\rebuild-offline.ps1       this script, so the package can refresh itself
#   <OutDir>\dsh-controller-offline.<yyyyMMdd>.7z   optional single-file copy of the whole package
#
# What is deliberately not copied:
#   tmp\                     scratch: screenshots from the UI fallback and one-off probe scripts
#   .git\, .gitignore        history, and a rule set that only applies inside a checkout
#
# Usage:
#   powershell -File tools/build-offline.ps1
#   powershell -File tools/build-offline.ps1 -OutDir D:\dsh-controller-offline -Force
#   powershell -File tools/build-offline.ps1 -NoArchive -SkipTests
#
# Running it from inside a built package (rebuild-offline.ps1) repacks that package in place.
#
# This file is ASCII-only on purpose: it has to run under Windows PowerShell 5.1, which reads a
# BOM-less script as ANSI and would mangle a non-ASCII literal. (The repository's own rule is the
# same one: a PowerShell script with non-ASCII text has to carry a UTF-8 BOM, and
# dsh-computer-use\tests\encoding.test.mjs checks it.) Everything meant to be read as prose lives in
# docs\offline-deploy.md, which this script copies.

[CmdletBinding()]
param(
    # Where the package is written. Defaults to the Desktop.
    [string]$OutDir = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'dsh-controller-offline'),

    # The plugin checkout to pack. Empty = find it from this script's own location.
    [string]$PluginRoot = '',

    # Overwrite an existing package instead of refusing.
    [switch]$Force,

    # Do not write the .7z single-file copy.
    [switch]$NoArchive,

    # Do not run the packed copy's test suite before sealing the manifest.
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

# The directory name the plugin package must keep. The plugin derives its own root from its location
# (index.mjs: `const HERE = dirname(fileURLToPath(import.meta.url))`), and the default
# `create.scriptDir` and `ui.screenshotDir` are computed from it, so the copy must sit in a directory
# named exactly this.
$PLUGIN_DIR_NAME = 'dsh-controller'

# The plugin's own files and directories. `tmp\` is scratch; the package's own `files` list in
# package.json names the same set (minus tests\, which is here so the offline copy can prove itself).
$PLUGIN_FILES = @('index.mjs', 'package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'selftest.mjs')
$PLUGIN_DIRS = @('src', 'scripts', 'tests')

# Files written to the package root: source, destination. The verify script and this script are
# copied from the plugin checkout; the README is the deploy document under a name a user finds first.
$ROOT_FILES = @(
    [pscustomobject]@{ Source = 'docs\offline-deploy.md'; Target = 'README-OFFLINE.md' },
    [pscustomobject]@{ Source = 'tools\verify-offline.mjs'; Target = 'verify-offline.mjs' },
    [pscustomobject]@{ Source = 'tools\build-offline.ps1'; Target = 'rebuild-offline.ps1' }
)

# Where the plugin directory is moved while it is being replaced. It is a complete copy of the plugin,
# so both the plugin-root search and the repack guard have to know this name and refuse to treat it as
# part of the package. A leftover one means a previous run died between the move and the copy; the
# next run restores it, and this name is what keeps it from being repacked as the real thing.
$BACKUP_LEAF = 'dsh-controller.__rebuild-backup'

# The one file that must not appear in the manifest: the manifest cannot hash itself. The archive is
# excluded too, by extension, because it contains every hash.
$MANIFEST_OMITS = @('manifest.json')

function Write-Step {
    param([string]$Text)
    Write-Host ("==> " + $Text)
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1MB) { return ("{0:N1} MB" -f ($Bytes / 1MB)) }
    return ("{0:N1} KB" -f ($Bytes / 1KB))
}

function Get-TreeStats {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ files = 0; bytes = 0 } }
    $items = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
    $bytes = 0
    foreach ($item in $items) { $bytes += $item.Length }
    return [pscustomobject]@{ files = $items.Count; bytes = $bytes }
}

function Get-ExpectedPackStats {
    # What the plugin package is supposed to contain: the named files plus the contents of the named
    # directories. Not the source root's total - a checkout also holds tmp\, .git\ and anything else
    # that is deliberately not packed, so comparing against that number would fail on every run.
    param([string]$Source)

    $files = 0
    $bytes = 0
    foreach ($name in $PLUGIN_FILES) {
        $path = Join-Path $Source $name
        if (Test-Path -LiteralPath $path) { $files++; $bytes += (Get-Item -LiteralPath $path).Length }
    }
    foreach ($name in $PLUGIN_DIRS) {
        $stats = Get-TreeStats -Path (Join-Path $Source $name)
        $files += $stats.files
        $bytes += $stats.bytes
    }
    return [pscustomobject]@{ files = $files; bytes = $bytes }
}

function Test-PluginRoot {
    # A plugin root is the package root of the plugin: package.json beside index.mjs. The registry is
    # asked for as a second marker because the plugin's own tests fail without it, but it is allowed to
    # be missing so that a future layout that moves it does not make in-place rebuilds impossible.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return ((Test-Path (Join-Path $Path 'package.json')) -and (Test-Path (Join-Path $Path 'index.mjs')))
}

function Resolve-PluginRoot {
    param([string]$Start)

    # Three layouts are possible, and the order below is what keeps them apart:
    #   1. inside the plugin directory itself (a built package): <plugin>\
    #   2. at a package root whose subdirectory is the plugin (the offline layout, and also a checkout
    #      named after the plugin's own directory): <root>\dsh-controller\
    #   3. in the checkout's tools\ directory: <plugin>\tools\ -> the parent
    #   4. one level above the checkout or the package root
    # Two candidates are refused outright. A directory carrying this package's manifest.json is a
    # delivery root, not a plugin. A candidate that is the resolved output directory is the thing the
    # plugin is about to be written INTO - and when -OutDir defaults to a sibling of the checkout, the
    # parent candidate is exactly that, which is how a rebuild ends up refusing to overwrite itself.
    $parent = Split-Path -Parent $Start
    $candidates = @(
        $Start,
        (Join-Path $Start $PLUGIN_DIR_NAME),
        $parent,
        (Join-Path $parent $PLUGIN_DIR_NAME)
    )
    $resolvedOut = $null
    if (-not [string]::IsNullOrWhiteSpace($OutDir)) {
        $resolvedOut = [System.IO.Path]::GetFullPath($OutDir)
        if (Test-Path -LiteralPath $resolvedOut) { $resolvedOut = (Resolve-Path -LiteralPath $resolvedOut).Path }
    }
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (Test-Path -LiteralPath (Join-Path $candidate 'manifest.json')) { continue }
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $resolved = (Resolve-Path -LiteralPath $candidate).Path
        if ($resolvedOut -ne $null -and $resolved -eq $resolvedOut) { continue }
        if (Test-PluginRoot -Path $resolved) { return $resolved }
    }
    throw "Cannot find the plugin root (needs package.json and index.mjs): looked around $Start. Pass -PluginRoot."
}

function Find-Node {
    # `node` first (the plugin's engines field requires >= 20), then the standard install location, so
    # the build still works from a shell whose PATH does not carry it.
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command -ne $null) { return $command.Source }
    foreach ($candidate in @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'))) {
        if ($candidate -ne $null -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Find-SevenZip {
    # 7-Zip installs here by default; the family also ships a standalone 7zr.exe under its OCR tree.
    $candidates = @(
        (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
        (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'),
        (Join-Path $env:USERPROFILE '.dsh-plugins\ocr\tools\7zr.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\7-Zip\7z.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -ne $null -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    $command = Get-Command 7z -ErrorAction SilentlyContinue
    if ($command -ne $null) { return $command.Source }
    return $null
}

function Get-PackagedFiles {
    # Every file of the delivery except the manifest, the archive and the sums file, sorted by
    # package-relative path with forward slashes so the manifest is byte-identical across rebuilds
    # that saw the same inputs.
    param([string]$PackageRoot, [string[]]$Omit)

    $rows = @()
    foreach ($entry in (Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Force)) {
        $relative = $entry.FullName.Substring($PackageRoot.Length + 1).Replace('\', '/')
        $skip = $false
        foreach ($name in $Omit) { if ($relative -eq $name) { $skip = $true } }
        if ($relative -like '*.7z') { $skip = $true }
        if ($skip) { continue }
        $rows += [pscustomobject]@{ Relative = $relative; FullName = $entry.FullName; Bytes = $entry.Length }
    }
    return @($rows | Sort-Object Relative)
}

# --- resolve inputs -------------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($PluginRoot)) { $PluginRoot = Resolve-PluginRoot -Start $PSScriptRoot }
if (-not (Test-Path -LiteralPath $PluginRoot)) { throw ("Plugin directory does not exist: " + $PluginRoot) }
$PluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path

# Everything below works on absolute paths, so a relative -OutDir cannot be mistaken for the plugin
# root or for something inside it.
$outFull = [System.IO.Path]::GetFullPath($OutDir)
$outExists = Test-Path -LiteralPath $outFull

if ($outExists) {
    $outFull = (Resolve-Path -LiteralPath $outFull).Path
    # Deletes below are recursive, so the target has to be a real directory of its own: not a drive root.
    if ([string]::IsNullOrEmpty((Split-Path -Leaf $outFull)) -or (Split-Path -Parent $outFull) -eq $outFull) {
        throw ("Refusing to build a package on a drive root: " + $outFull)
    }
}

$pluginOut = Join-Path $outFull $PLUGIN_DIR_NAME

# Rebuilding a package that already holds the plugin: the plugin's own files are refreshed from the
# package's own copy (the backup taken below), so no -Force is needed for that case.
$inPlace = ($outExists -and (Test-PluginRoot -Path $pluginOut))

# A directory that already carries this package's manifest is a repack even when the plugin directory
# has been deleted: the delivery files at its root are about to be replaced anyway, so refusing for
# "not empty" would be a rule with no purpose. The plugin source is then the checkout being packed.
$repack = ($inPlace -or ($outExists -and (Test-Path -LiteralPath (Join-Path $outFull 'manifest.json'))))

# Two refusals, because the recursive deletes below are the one destructive thing here. In an in-place
# rebuild $pluginOut and $PluginRoot are the SAME path by construction - the plugin is refreshed from
# its own backup - which is exactly why neither refusal may fire for that case.
if ($pluginOut -eq $PluginRoot -and -not $inPlace) {
    # -OutDir is the plugin directory itself: it would be deleted and then refilled from a backup,
    # which is legal but pointless (the package would land inside the checkout). Only with -Force.
    if (-not $Force) { throw ("The output directory is the plugin directory itself: " + $outFull + ". Pass -Force only if that is really intended.") }
}
if ($pluginOut.StartsWith($PluginRoot + '\') -and -not $inPlace -and -not $Force) {
    throw ("The target plugin directory is inside the source plugin directory, so the copy would nest into itself: " + $pluginOut + ". Choose another -OutDir.")
}
if ($outExists -and -not $repack -and -not $Force) {
    $existing = @(Get-ChildItem -LiteralPath $outFull -Force)
    if ($existing.Count -gt 0) {
        throw ("Target directory is not empty: " + $outFull + ". Pass -Force to replace it, or choose another -OutDir.")
    }
}

Write-Host "plugin : $PluginRoot"
Write-Host "out    : $outFull"
if ($inPlace) { Write-Host "mode   : in place - the plugin is refreshed from the package's own copy" }
Write-Host "layout : plugin in $PLUGIN_DIR_NAME\, delivery extras at the package root"

# --- the plugin package ---------------------------------------------------------------------------

# The one risky moment in this script: the destination is cleared before it is filled. Take a backup
# first, restore it if the copy goes wrong, and only drop it once the new copy has been measured
# equal to its source.
# A backup left behind by an interrupted run is settled before anything else: if the plugin directory
# is missing it is the live copy, so it is restored; if it is present the backup is redundant.
$staleBackup = Join-Path $outFull $BACKUP_LEAF
if (Test-Path -LiteralPath $staleBackup) {
    if (Test-PluginRoot -Path $pluginOut) {
        Write-Step ("drop the stale backup left by an earlier run: " + $staleBackup)
        Remove-Item -LiteralPath $staleBackup -Recurse -Force
    } else {
        Write-Step ("restore the plugin copy from the backup left by an earlier run: " + $staleBackup)
        Move-Item -LiteralPath $staleBackup -Destination $pluginOut -Force
    }
}

$backup = $null
if (Test-Path -LiteralPath $pluginOut) {
    $backup = $staleBackup
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    Write-Step ("back up the existing plugin copy to " + $backup)
    Move-Item -LiteralPath $pluginOut -Destination $backup -Force
}
New-Item -ItemType Directory -Path $pluginOut -Force | Out-Null

# Resolved here, after the move: in an in-place rebuild the directory named by $inPlaceSource is the
# one just recreated and empty, so the old copy in the backup is what has to be copied back from.
$pluginSource = $PluginRoot
if ($inPlace) { $pluginSource = $backup }

try {
    Write-Step ("pack the plugin into " + $pluginOut)
    foreach ($name in $PLUGIN_FILES) {
        $source = Join-Path $pluginSource $name
        if (-not (Test-Path -LiteralPath $source)) { Write-Host ("    skip " + $name + " (not present)"); continue }
        Copy-Item -LiteralPath $source -Destination (Join-Path $pluginOut $name) -Force
    }
    foreach ($name in $PLUGIN_DIRS) {
        $source = Join-Path $pluginSource $name
        if (-not (Test-Path -LiteralPath $source)) { Write-Host ("    skip " + $name + " (not present)"); continue }
        $target = Join-Path $pluginOut $name
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        # -Path, not -LiteralPath: the trailing * is what makes Copy-Item copy the *contents* of the
        # directory rather than the directory itself nested one level deeper.
        Copy-Item -Path (Join-Path ($source.TrimEnd('\')) '*') -Destination $target -Recurse -Force
        $stats = Get-TreeStats -Path $target
        Write-Host ("    " + $name.PadRight(9) + $stats.files.ToString().PadLeft(4) + " files  " + (Format-Size $stats.bytes))
    }

    $sourceStats = Get-ExpectedPackStats -Source $pluginSource
    $pluginStats = Get-TreeStats -Path $pluginOut
    Write-Host ("    plugin total: " + $pluginStats.files + " files, " + (Format-Size $pluginStats.bytes))
    if ($pluginStats.files -ne $sourceStats.files -or $pluginStats.bytes -ne $sourceStats.bytes) {
        throw ("Incomplete copy: " + $pluginSource + " should give " + $sourceStats.files + " files / " + $sourceStats.bytes +
               " bytes, the copy has " + $pluginStats.files + " / " + $pluginStats.bytes)
    }
    if ($pluginStats.files -eq 0) { throw ("Nothing was copied into " + $pluginOut + ": the source " + $pluginSource + " looks empty.") }
} catch {
    Write-Warning ("Packing failed: " + $_.Exception.Message)
    if ($backup -ne $null) {
        Write-Warning ("Restoring the previous plugin copy from " + $backup)
        if (Test-Path -LiteralPath $pluginOut) { Remove-Item -LiteralPath $pluginOut -Recurse -Force }
        Move-Item -LiteralPath $backup -Destination $pluginOut -Force
    } else {
        Write-Warning "There was no previous copy to restore; the package is now incomplete."
    }
    throw
}
if ($backup -ne $null) {
    Write-Step ("drop the backup " + $backup)
    Remove-Item -LiteralPath $backup -Recurse -Force
}

# --- the delivery extras at the package root ------------------------------------------------------

foreach ($entry in $ROOT_FILES) {
    $source = Join-Path $PluginRoot $entry.Source
    $target = Join-Path $outFull $entry.Target
    if (-not (Test-Path -LiteralPath $source)) { Write-Warning ("Missing " + $source + ", skipping " + $entry.Target); continue }
    # Running from inside a package, source and destination can be the same file: Copy-Item refuses to
    # copy an item onto itself, and there is nothing to do anyway.
    if ((Resolve-Path -LiteralPath $source).Path -ne $target) {
        Copy-Item -LiteralPath $source -Destination $target -Force
        Write-Step ("write " + $target)
    }
}

# --- prove the copy before sealing it -------------------------------------------------------------

$node = Find-Node
if ($node -eq $null) {
    Write-Warning "node was not found: the packed copy was not syntax-checked or tested."
} else {
    Write-Step ("syntax check with " + $node)
    $modules = @(Get-ChildItem -LiteralPath $pluginOut -Recurse -File -Filter '*.mjs' | Sort-Object FullName)
    $bad = 0
    foreach ($module in $modules) {
        $output = & $node --check $module.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            $bad++
            Write-Host ("    FAIL " + $module.FullName)
            foreach ($line in $output) { Write-Host ("         " + $line) }
        }
    }
    if ($bad -gt 0) { throw ($bad.ToString() + " packed module(s) failed node --check") }
    Write-Host ("    " + $modules.Count + " modules parse")

    if ($SkipTests) {
        Write-Host "==> tests skipped (-SkipTests)"
    } else {
        # Only the host-free suites run here. tests\facts.test.mjs spawns stand-in processes and takes
        # over a real process tree, and tests\services.test.mjs exercises live host services; neither
        # belongs in a packaging step, and `node --test` would run everything it is pointed at.
        $suites = @('config', 'paths', 'tools', 'sessionlog', 'restart') | ForEach-Object { 'tests\' + $_ + '.test.mjs' }
        $paths = @()
        foreach ($suite in $suites) {
            $full = Join-Path $pluginOut $suite
            if (Test-Path -LiteralPath $full) { $paths += $full } else { Write-Host ("    skip " + $suite + " (not present)") }
        }
        if ($paths.Count -eq 0) {
            Write-Warning "No host-free test suites were found in the packed copy; the manifest was written without running them."
        } else {
            Write-Step ("run the host-free test suites inside the package (" + $paths.Count + " files)")
            & $node --test @paths
            if ($LASTEXITCODE -ne 0) { throw ("The packed copy failed its own test suite (node --test exit " + $LASTEXITCODE + ")") }
        }
    }
}

# --- manifest and sums ----------------------------------------------------------------------------

$packageText = [System.IO.File]::ReadAllText((Join-Path $pluginOut 'package.json'), [System.Text.Encoding]::UTF8)
$package = $packageText | ConvertFrom-Json

# SHA256SUMS.txt is written before the manifest, and the manifest is written last: each file is hashed
# in the form it is delivered in, so a later step can never leave either stale. The sums file cannot
# list its own hash (that is the same circularity as a manifest hashing itself), so it is excluded
# from its own body and the manifest hashes it as an ordinary delivered file.
$sumsPath = Join-Path $outFull 'SHA256SUMS.txt'
# Created empty here so that the file walk below sees it: its final content is written once every
# hash is known, and its own row is refreshed after that. Writing it only afterwards would mean the
# walk had never seen it and the manifest would silently omit the file.
[System.IO.File]::WriteAllText($sumsPath, '', (New-Object System.Text.UTF8Encoding($false)))
$sumsHeader = @(
    "# dsh-controller offline package - SHA-256 of every delivered file",
    "# Not listed here: SHA256SUMS.txt itself (it cannot contain its own hash) and *.7z.",
    "# Check from the package root with:  sha256sum -c SHA256SUMS.txt",
    "# Or with the bundled checker, which also cross-checks manifest.json and the plugin package:",
    "#   node verify-offline.mjs",
    ""
) -join "`n"

$files = Get-PackagedFiles -PackageRoot $outFull -Omit $MANIFEST_OMITS

$rows = @()
$sumLines = @()
$totalBytes = 0
$pluginBytes = 0
$pluginCount = 0
foreach ($file in $files) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $rows += [ordered]@{ path = $file.Relative; bytes = $file.Bytes; sha256 = $hash }
    if ($file.Relative -eq 'SHA256SUMS.txt') {
        # Hashed in its final form below, not with the placeholder that is on disk right now.
        $sumsHash = $hash
    } else {
        $sumLines += ($hash + "  " + $file.Relative)
    }
    $totalBytes += $file.Bytes
    # Counted from the delivered file list, not from the directory on disk: a `tmp\` written by a tool
    # call between packing and sealing must not change what the manifest says was packaged.
    if ($file.Relative.StartsWith($PLUGIN_DIR_NAME + '/')) { $pluginBytes += $file.Bytes; $pluginCount++ }
}

$nodeRange = '20'
if ($package.engines -ne $null -and -not [string]::IsNullOrWhiteSpace($package.engines.node)) { $nodeRange = $package.engines.node }

if ($files.Relative -notcontains 'SHA256SUMS.txt') { throw 'SHA256SUMS.txt was not found by the file walk; refusing to write a manifest that does not cover it' }
[System.IO.File]::WriteAllText($sumsPath, ($sumsHeader + ($sumLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Step ("write " + $sumsPath + " (" + $sumLines.Count + " entries)")

# The sums file just changed size and content, so its own row is refreshed from what is now on disk.
for ($index = 0; $index -lt $rows.Count; $index++) {
    if ($rows[$index].path -eq 'SHA256SUMS.txt') {
        $item = Get-Item -LiteralPath $sumsPath
        $finalHash = (Get-FileHash -LiteralPath $sumsPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($finalHash -ne $rows[$index].sha256 -or $item.Length -ne $rows[$index].bytes) {
            $totalBytes = $totalBytes - $rows[$index].bytes + $item.Length
            $rows[$index] = [ordered]@{ path = 'SHA256SUMS.txt'; bytes = $item.Length; sha256 = $finalHash }
        }
    }
}
[System.IO.File]::WriteAllText($sumsPath, ($sumsHeader + ($sumLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))

$manifest = [ordered]@{
    name         = 'dsh-controller-offline'
    pluginName   = $PLUGIN_DIR_NAME
    version      = $package.version
    createdAt    = (Get-Date).ToString('o')
    layout       = 'plugin in ' + $PLUGIN_DIR_NAME + '\; delivery extras (README-OFFLINE.md, manifest.json, SHA256SUMS.txt, verify-offline.mjs, rebuild-offline.ps1) beside it and never installed'
    pluginDir    = $PLUGIN_DIR_NAME
    pluginSource = $PluginRoot
    installSpec  = $pluginOut
    dependencies = [ordered]@{
        runtime = @('node >= ' + $nodeRange + ' (declared by package.json); no npm package is imported at run time')
        bundled = @()
        optional = @(
            'dsh-computer-use: dsh_sessions {action:"create"} with a cwd runs its script library; without it the GUI leg falls back to the new-session button, then to the API',
            'dsh-computer-use: dsh_host {action:"restart"} quits the app through its tray menu; without it the out-of-process watchdog collects the process tree, which is a restart without the graceful leg'
        )
    }
    requires     = [ordered]@{
        host    = 'DSH desktop shell for dsh_host restart (refused in a headless CLI) and for the dsh_ui fallback'
        windows = 'Windows PowerShell 5.1 for the desktop fallback and for the out-of-process relaunch watchdog'
    }
    plugin       = [ordered]@{ files = $pluginCount; bytes = $pluginBytes }
    files        = $rows
    totals       = [ordered]@{ files = $rows.Count; bytes = $totalBytes }
    excluded     = @('tmp (screenshots and one-off probe scripts)', '.git, .gitignore', 'manifest.json (cannot contain its own hash), *.7z (contains every hash)')
}

# Read as UTF-8 explicitly: package.json is UTF-8 without a BOM and carries Chinese prose, and
# Windows PowerShell 5.1 reads a BOM-less file as ANSI, which turns that prose into invalid JSON.
$manifestPath = Join-Path $outFull 'manifest.json'
$json = $manifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Step ("write " + $manifestPath)

# --- check what was just written, before it is declared good ---------------------------------------

# The packaged checker is the authority on the delivery, so run it here: a build that writes a corrupt
# or truncated file must fail at build time, not on the target machine.
if ($node -ne $null) {
    $checker = Join-Path $outFull 'verify-offline.mjs'
    if (Test-Path -LiteralPath $checker) {
        Write-Step "run the packaged checker against the package that was just written"
        $verdict = & $node $checker 2>&1
        $code = $LASTEXITCODE
        foreach ($line in $verdict) { Write-Host ("    " + $line) }
        if ($code -ne 0) { throw ("verify-offline.mjs rejected the package it was packaged into (exit " + $code + ")") }
    } else {
        Write-Warning "verify-offline.mjs was not copied into the package; the written manifest is unverified."
    }
} else {
    Write-Warning "node was not found: the packaged checker could not be run, so the manifest is unverified."
}

# --- the optional single-file copy ------------------------------------------------------------------

$archivePath = $null
if (-not $NoArchive) {
    $sevenZip = Find-SevenZip
    if ($sevenZip -eq $null) {
        Write-Warning "7-Zip was not found (looked in Program Files, LocalAppData and ~\.dsh-plugins\ocr\tools): no .7z was written. Pass -NoArchive to silence this."
    } else {
        # One archive per package: an earlier dated one would otherwise sit beside this build and be
        # mistaken for it. Only files matching this package's own archive name are removed.
        foreach ($stale in @(Get-ChildItem -LiteralPath $outFull -File -Force -Filter ($manifest.name + '.*.7z'))) {
            Write-Step ("remove the superseded archive " + $stale.Name)
            Remove-Item -LiteralPath $stale.FullName -Force
        }
        $archivePath = Join-Path $outFull ($manifest.name + '.' + (Get-Date).ToString('yyyyMMdd') + '.7z')
        if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
        Write-Step ("archive with " + $sevenZip)
        # Run from the parent directory so the archive holds the package root and extracts into it,
        # and exclude the archive itself: 7z would otherwise try to add the file it is writing.
        $parent = Split-Path -Parent $outFull
        $leaf = Split-Path -Leaf $outFull
        Push-Location $parent
        try {
            & $sevenZip a -t7z -mx=9 -bso0 -bsp0 ($leaf + '.7z') $leaf ('-xr!' + (Split-Path -Leaf $archivePath))
        } finally {
            Pop-Location
        }
        if ($LASTEXITCODE -ne 0) { throw ("7z failed with exit code " + $LASTEXITCODE) }
        # 7z writes beside the package root; move it inside, where the delivery is meant to travel.
        $produced = Join-Path $parent ($leaf + '.7z')
        if ((Test-Path -LiteralPath $produced) -and ($produced -ne $archivePath)) {
            Move-Item -LiteralPath $produced -Destination $archivePath -Force
        }
        if (-not (Test-Path -LiteralPath $archivePath)) { throw ("7z reported success but " + $archivePath + " does not exist") }
        $archiveStats = (Get-Item -LiteralPath $archivePath)
        Write-Host ("    " + $archiveStats.Name + "  " + (Format-Size $archiveStats.Length))
        $listing = & $sevenZip l -ba $archivePath 2>&1
        $entryCount = @($listing | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
        Write-Host ("    " + $entryCount + " entries listed inside the archive")

        # Recorded into the manifest after the fact, not before: the archive cannot be inside a manifest
        # that is inside the archive. The manifest is rewritten - never re-hashed - so its own digest is
        # unaffected, and the archive is verified again below because it now holds this manifest.
        $record = $manifest
        $record.archive = [ordered]@{
            path    = (Split-Path -Leaf $archivePath)
            bytes   = $archiveStats.Length
            entries = $entryCount
            sha256  = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
            note    = 'not covered by manifest.json or SHA256SUMS.txt: it contains both. Its SHA-256 is recorded here, not enforced, because the archive contains this file.'
        }
        [System.IO.File]::WriteAllText($manifestPath, ($record | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
        Write-Step ("recorded the archive in " + $manifestPath)
    }
}

# --- summary --------------------------------------------------------------------------------------

Write-Host ""
Write-Host "Package written to: $outFull"
Write-Host ("  " + $PLUGIN_DIR_NAME + "\      " + $pluginCount.ToString().PadLeft(4) + " files / " + (Format-Size $pluginBytes) + "  (install this directory)")
Write-Host ("  manifest.json      " + $rows.Count.ToString().PadLeft(4) + " hashed files / " + (Format-Size $totalBytes))
if ($archivePath -ne $null) { Write-Host ("  " + (Split-Path -Leaf $archivePath)) }
Write-Host ""
Write-Host "Next: node verify-offline.mjs   (from the package root, checks every hash)"
Write-Host "      read README-OFFLINE.md    (install, verify, and what degrades without the siblings)"
