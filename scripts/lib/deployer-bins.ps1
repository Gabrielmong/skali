# Resolves the absolute tool paths written into deployer.json and checks they are system-wide.
# Ported from Home (scripts/lib/deployer-bins.ps1) without pg_dump. Dot-source after common.ps1; do not run.

# Runs a native command for its output: stderr is dropped and never turns into a terminating error (Windows PowerShell
# 5.1 does that to redirected native stderr under $ErrorActionPreference = 'Stop'). Returns the exit code and stdout lines.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    $out = @(& $Exe @Arguments 2>$null | ForEach-Object { "$_" })
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
}

# Runs $Action with $Vars set in this process's environment (inherited by the native commands it starts), then puts
# every variable back as it was. Only for values that are not secret (secrets go through Invoke-GitWithToken).
function Use-ProcessEnv([System.Collections.IDictionary]$Vars, [scriptblock]$Action) {
    $saved = @{}
    foreach ($k in @($Vars.Keys)) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, [string]$Vars[$k], 'Process')
    }
    try { & $Action } finally {
        foreach ($k in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
}

# Absolute path of a command, or $null. Application type skips pnpm.ps1 shims and aliases.
function Find-Bin([string]$Name) {
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $cmd.Source } else { $null }
}

# The path with every linked folder on the way resolved (nvm-style C:\nvm4w\nodejs links into a profile).
function Resolve-LinkedPath([string]$Path) {
    $parts = $Path.TrimEnd('\') -split '\\'
    $current = $parts[0] + '\'
    foreach ($part in ($parts | Select-Object -Skip 1)) {
        $current = Join-Path $current $part
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and $item.LinkType -and $item.Target) {
            $target = @($item.Target)[0]
            if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path $current) $target }
            $current = $target
        }
    }
    $current
}

# The helper runs pnpm, git, node, nssm, powershell and tar as LocalSystem on every deploy: a copy inside a user profile
# (%APPDATA%, %LOCALAPPDATA%, C:\Users\, OneDrive) could be replaced by that user. Returns the problem, or $null.
function Get-BinProfileProblem([string]$Name, [string]$Path) {
    $resolved = Resolve-LinkedPath $Path
    $userRoots = @($env:APPDATA, $env:LOCALAPPDATA, $env:OneDrive, (Join-Path $env:SystemDrive 'Users')) | Where-Object { $_ }
    $inProfile = $userRoots | Where-Object { $resolved.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }
    if (-not $inProfile) { return $null }
    "$Name resolves to $resolved, inside a user profile. The helper runs it as LocalSystem on every deploy; install it system-wide (for example under Program Files) and re-run."
}

# git 2.31+ reads GIT_CONFIG_COUNT/KEY_n/VALUE_n from the environment (how the token reaches git). Returns the problem, or $null.
function Get-GitVersionProblem([string]$Git) {
    $text = "$((Invoke-Native $Git @('--version')).Output)"
    if ($text -notmatch '(\d+)\.(\d+)') { return "Could not read the git version from '$text'." }
    if (([int]$Matches[1] -lt 2) -or ([int]$Matches[1] -eq 2 -and [int]$Matches[2] -lt 31)) {
        return "git 2.31 or newer is required (the token is passed through GIT_CONFIG_* environment variables); found: $text. Run: winget install Git.Git"
    }
    Write-Host "  git version ok: $text"
    $null
}

# Name -> absolute path for every tool the deployer runs, plus the problems found (missing, under a user profile, git
# too old, node too old). A missing tool gets a '<name>' placeholder so a dry run can continue.
function Get-DeployerBins {
    $problems = @()
    $node = $null
    try { $node = Get-NodePath } catch { $problems += $_.Exception.Message }
    $found = [ordered]@{
        node       = $node
        pnpm       = Find-Bin 'pnpm'
        git        = Find-Bin 'git'
        nssm       = Find-Bin 'nssm'
        powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        tar        = Join-Path $env:SystemRoot 'System32\tar.exe'
    }
    foreach ($name in @($found.Keys)) {
        $path = $found[$name]
        if ($path -and (Test-Path -LiteralPath $path)) {
            Write-Host ("  {0,-10} {1}" -f $name, $path)
            if ($name -ne 'node') {   # node: Test-NodeIsSystemWide below is stricter (Program Files only)
                $p = Get-BinProfileProblem $name $path
                if ($p) { $problems += $p }
            }
            continue
        }
        if ($name -ne 'node' -or $node) {   # a missing node was reported by Get-NodePath already
            $hint = switch ($name) { 'nssm' { ' Run: choco install nssm' } 'pnpm' { ' Run: corepack enable' } 'git' { ' Run: winget install Git.Git' } default { '' } }
            $problems += "$name was not found.$hint"
        }
        $found[$name] = "<$name>"
    }
    if ($node -and (Test-Path -LiteralPath $node)) {
        try { Test-NodeIsSystemWide $node } catch { $problems += $_.Exception.Message }
        try { Assert-NodeVersion $node } catch { $problems += $_.Exception.Message }
    }
    if ($found.git -notlike '<*') {
        $g = Get-GitVersionProblem $found.git
        if ($g) { $problems += $g }
    }
    [pscustomobject]@{ Bins = $found; Problems = $problems }
}
