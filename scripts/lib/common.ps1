# Shared helpers for the Windows deployment scripts. Dot-source this file; do not run it.

function Test-IsAdmin {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Stops unless running as Administrator. A dry run changes nothing, so it only reports.
function Assert-Admin([switch]$DryRun) {
    if (Test-IsAdmin) { return }
    if ($DryRun) { Write-Host '[dry-run] would fail: not running elevated (a real run needs an elevated PowerShell)'; return }
    throw 'Run this script from an elevated (Administrator) PowerShell.'
}

# Runs (or, in a dry run, only prints) one step. Native-command failures stop the script.
function Invoke-Step([string]$Description, [scriptblock]$Action, [switch]$DryRun) {
    if ($DryRun) { Write-Host "[dry-run] $Description"; return }
    Write-Host $Description
    $global:LASTEXITCODE = 0
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "Step failed (exit code $LASTEXITCODE): $Description" }
}

function Get-NodePath {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node was not found on PATH. Install Node 22 LTS first (winget install OpenJS.NodeJS.LTS).' }
    # NSSM's Application and the firewall -Program must name the real image: a symlinked node.exe would match no rule.
    $item = Get-Item -LiteralPath $node.Source
    if ($item.Target) {
        $target = @($item.Target)[0]
        if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path $node.Source -Parent) $target }
        return (Resolve-Path -LiteralPath $target).Path
    }
    $node.Source
}

# Stops unless node is 22.12 or newer (the repo's engines field).
function Assert-NodeVersion([string]$NodePath) {
    $text = (& $NodePath -v).Trim()
    $version = [version]($text.TrimStart('v') -replace '[^0-9.].*$', '')
    if ($version -lt [version]'22.12') {
        throw "node $text is too old: install Node 22.12 or newer (the current Node 22 LTS installer from nodejs.org), open a new shell and re-run."
    }
}

# Stops unless node (symlinks resolved) is under Program Files (a dry run only reports). A per-user node (nvm, fnm,
# volta) lives in a profile folder and the firewall rule is pinned to node.exe, so require a system-wide install.
function Test-NodeIsSystemWide([string]$NodePath, [switch]$DryRun) {
    $item = Get-Item $NodePath
    $resolved = if ($item.Target) { @($item.Target)[0] } else { $NodePath }
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    if (-not ($roots | Where-Object { $resolved.StartsWith($_ + '', [StringComparison]::OrdinalIgnoreCase) })) {
        $msg = "node resolves to $resolved, outside Program Files. Install Node 22 system-wide (official MSI), open a new shell so ``node`` finds it, and re-run."
        if ($DryRun) { Write-Host "[dry-run] would fail: $msg" } else { throw $msg }
    }
}
