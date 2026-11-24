<#
.SYNOPSIS
  Builds Skali and installs or updates the NSSM service "Skali" (LocalSystem, port 4100).
  Run as Administrator; re-running updates the existing service. Use -DryRun to preview: it prints every step,
  changes nothing, needs no elevation, and reports missing prerequisites as "would fail" instead of stopping.
.PARAMETER AllowIp
  Client IPs/CIDRs allowed to open the web UI the first time the database is created
  (SKALI_INITIAL_ALLOWLIST). Afterwards the list is edited on the Settings page. 127.0.0.1 is always allowed.
.NOTES
  Game servers run detached as the SkaliGames user, so stopping or restarting this service never stops them.
#>
param([string[]]$AllowIp = @('192.168.0.150'), [switch]$DryRun)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot\lib\common.ps1"
. "$PSScriptRoot\lib\acl.ps1"
. "$PSScriptRoot\lib\service.ps1"

$serviceName = 'Skali'
$port = 4100
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$dataDir = 'C:\ProgramData\Skali'
$serviceLog = Join-Path $dataDir 'service.log'
$serverDir = Join-Path $repo 'apps\server'
$mainJs = Join-Path $serverDir 'dist\main.js'
# NSSM stores AppParameters verbatim (no quoting), so use a path relative to AppDirectory: it never contains spaces.
$mainJsRelative = 'apps\server\dist\main.js'
# config.ts: helperPath = <repo>\tools\SkaliHelper\publish\SkaliHelper.exe (produced by `pnpm build`, see below)
$helperExe = Join-Path $repo 'tools\SkaliHelper\publish\SkaliHelper.exe'
$webRule = 'Skali web (TCP 4100)'

if ($DryRun) { Write-Host "[dry-run] Skali installer: nothing below is executed or changed." }

# Reports a failed prerequisite: throws in a real run, prints "would fail" in a dry run.
function Report-Problem([string]$Message) {
    if ($DryRun) { Write-Host "[dry-run] would fail: $Message" } else { throw $Message }
}

# 1. Prerequisites
Assert-Admin -DryRun:$DryRun

# LocalSystem runs code from the repo and the lockdown removes your own access, so keep it out of sync folders.
$profileRoots = @($env:USERPROFILE, $env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) | Where-Object { $_ }
if ($profileRoots | Where-Object { $repo.StartsWith($_.TrimEnd([char]92) + [string][char]92, [StringComparison]::OrdinalIgnoreCase) }) {
    Write-Warning "The repo ($repo) is under a user profile or OneDrive. The lockdown breaks OneDrive sync and LocalSystem can't read Files On-Demand placeholders. Use a plain local folder such as C:\skali."
}

if ($DryRun) {
    $longPaths = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
    if ($longPaths -ne 1) { Write-Warning 'Win32 long paths are not enabled (HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled is not 1). A very long node_modules path can make the repo ACL reset fail and abort the install. See docs/RUNNING.md.' }
}

$node = $null
try {
    $node = Get-NodePath
    Test-NodeIsSystemWide $node -DryRun:$DryRun
    Assert-NodeVersion $node
    Write-Host "node: $node $((& $node -v).Trim())"
} catch { Report-Problem $_.Exception.Message }

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Report-Problem 'pnpm was not found. Run: corepack enable  (or: npm install -g pnpm)' }
else { Write-Host "pnpm: $((pnpm --version).Trim())" }

# `dotnet --list-sdks` (not --version): a machine with runtimes but no SDK makes --version fail.
$dotnetMsg = 'dotnet SDK 10 was not found (runtimes alone are not enough). Run: winget install Microsoft.DotNet.SDK.10'
$dotnetSdk = $null
if (Get-Command dotnet -ErrorAction SilentlyContinue) {
    try {
        $ErrorActionPreference = 'Continue'
        $sdkLines = @(& dotnet --list-sdks 2>$null | ForEach-Object { "$_" })
        $sdkExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($sdkExit -eq 0) {
            $dotnetSdk = $sdkLines | Where-Object { $_ -match '^(\d+)\.' -and [int]$Matches[1] -ge 10 } | Select-Object -Last 1
        }
    } catch { $ErrorActionPreference = 'Stop' }
}
if ($dotnetSdk) { Write-Host "dotnet SDK: $dotnetSdk" } else { Report-Problem $dotnetMsg }

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) { Report-Problem 'nssm was not found. Run: choco install nssm' }
else { Write-Host 'nssm: found' }

# Remember the starting state so a failure message can say what was actually left behind.
$before = Get-Service $serviceName -ErrorAction SilentlyContinue

# Stop first so the build never runs under a live service. Games run detached and keep running; make sure an
# older service definition doesn't kill the process tree on stop.
if ($before) { Set-NssmValue $serviceName 'AppKillProcessTree' '0' -DryRun:$DryRun }
Stop-ServiceIfRunning $serviceName -DryRun:$DryRun

$nativeGuidance = "better-sqlite3 is native: use a Node version that has a prebuilt binary for it (Node 22 or 24 LTS, system-wide), or install the build tools (winget install Microsoft.VisualStudio.2022.BuildTools, with the 'Desktop development with C++' workload), then re-run."
try {
    # 2. Delete node_modules, lock the (now small) repo, THEN install and build. Why this order (and fast):
    #  - every node_modules (root, apps\*, packages\*) is deleted first, so the recursive icacls passes and link walks only
    #    see the source tree instead of ~60k node_modules entries;
    #  - pnpm install and the build run AFTER the lock: every file they create inherits the locked root ACL (the repo
    #    .npmrc has package-import-method=copy, so install writes private copies that carry no ACL of their source, and
    #    never hard links into the user-writable pnpm store), so node_modules and the build outputs need no ACL pass;
    #  - non-admins cannot write under the locked root, so no further link walk is needed after the install.
    # The service is stopped during this window, so nothing executes the files meanwhile.
    Remove-NodeModulesDirs $repo -DryRun:$DryRun

    # 3. Only admins may change what LocalSystem executes: root first, then link check, recursive owner + reset, second
    # link check (links that point outside the repo abort the run). See Protect-RepoDirectory.
    Protect-RepoDirectory $repo -DryRun:$DryRun

    # 4. Dependencies and build, inside the locked repo. The root build compiles shared, server and web, then publishes SkaliHelper
    # (`dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true`) into tools\SkaliHelper\publish.
    Push-Location $repo
    try {
        try { Invoke-Step 'pnpm install --frozen-lockfile' { pnpm install --frozen-lockfile } -DryRun:$DryRun }
        catch { throw "$($_.Exception.Message). If the output above shows a better-sqlite3 build error: $nativeGuidance" }
        # better-sqlite3 is native: prove it loads under the system Node before the service ever starts.
        Invoke-Step 'Verifying better-sqlite3 loads under the system Node' {
            Push-Location $serverDir
            try {
                # Windows PowerShell 5.1 turns redirected native stderr into a terminating error under 'Stop',
                # which would hide the guidance below, so this check runs with 'Continue'.
                $ErrorActionPreference = 'Continue'
                $global:LASTEXITCODE = 0
                $loadOut = @(& $node -e "new (require('better-sqlite3'))(':memory:').close()" 2>&1 | ForEach-Object { "$_" })
                $loadExit = $LASTEXITCODE
                $ErrorActionPreference = 'Stop'
                if ($loadExit -ne 0) {
                    $tail = ($loadOut | Where-Object { $_.Trim() } | Select-Object -Last 4) -join ' | '
                    throw "better-sqlite3 failed to load under node ($tail). $nativeGuidance"
                }
            } finally { $ErrorActionPreference = 'Stop'; Pop-Location }
        } -DryRun:$DryRun
        Invoke-Step 'pnpm build (shared, server, web, SkaliHelper publish)' { pnpm build } -DryRun:$DryRun
        Invoke-Step "Checking build output ($mainJs, $helperExe, apps\web\dist)" {
            foreach ($f in $mainJs, $helperExe, (Join-Path $repo 'apps\web\dist\index.html')) {
                if (-not (Test-Path -LiteralPath $f)) { throw "Build output missing: $f" }
            }
        } -DryRun:$DryRun
    } finally { Pop-Location }

    # 4b. Sampled check only (no recursive pass): the root ACL, a sample of children including node_modules and the helper
    # publish folder, and no hard-linked files in node_modules.
    if ($DryRun) { Write-Host "[dry-run] Assert-RepoRootAcl (root + sampled children incl. node_modules\.pnpm, apps\server\node_modules\better-sqlite3, tools\SkaliHelper\publish); verifying node_modules has no hard-linked files" }
    else { Assert-RepoRootAcl $repo; Assert-NodeModulesNotHardLinked $repo }

    # 5. Data dir: created locked down (or verified trusted, never repaired) BEFORE the service first starts.
    Initialize-DataDirectory $dataDir -DryRun:$DryRun   # create fresh with its final ACL, or accept an already-trusted one, or throw
    if (-not $DryRun) { Assert-DataDirAcl $dataDir }
} catch {
    Write-Warning "Install failed: $($_.Exception.Message)"
    if ($before) { Write-Warning "$serviceName was stopped for the update (running games are unaffected). Fix the problem and re-run; to start the old build: nssm start $serviceName" }
    else { Write-Warning "No $serviceName service was installed yet. Fix the problem above and re-run this script." }
    throw
}

# 6. Service
$nodeArg = if ($node) { $node } else { '<node.exe>' }
if (-not (Get-Service $serviceName -ErrorAction SilentlyContinue)) {
    Invoke-Step "nssm install $serviceName $nodeArg $mainJsRelative" { nssm install $serviceName $node $mainJsRelative | Out-Null } -DryRun:$DryRun
} else {
    Set-NssmValue $serviceName 'Application' $nodeArg -DryRun:$DryRun
    Set-NssmValue $serviceName 'AppParameters' $mainJsRelative -DryRun:$DryRun
}
Set-NssmValue $serviceName 'AppDirectory' $repo -DryRun:$DryRun
Set-NssmValue $serviceName 'ObjectName' 'LocalSystem' -DryRun:$DryRun
Set-NssmValue $serviceName 'Start' 'SERVICE_AUTO_START' -DryRun:$DryRun
Set-NssmValue $serviceName 'AppKillProcessTree' '0' -DryRun:$DryRun
Set-NssmValue $serviceName 'AppStopMethodConsole' '15000' -DryRun:$DryRun
Set-NssmValues $serviceName 'AppExit' @('Default', 'Restart') -DryRun:$DryRun
Set-NssmValue $serviceName 'AppRestartDelay' '5000' -DryRun:$DryRun
Set-NssmValue $serviceName 'AppStdout' $serviceLog -DryRun:$DryRun
Set-NssmValue $serviceName 'AppStderr' $serviceLog -DryRun:$DryRun
Set-NssmValue $serviceName 'AppRotateFiles' '1' -DryRun:$DryRun
Set-NssmValue $serviceName 'AppRotateBytes' '10485760' -DryRun:$DryRun
# NODE_ENV=production makes the server serve the built web app. The allowlist only seeds a NEW database.
Set-NssmValues $serviceName 'AppEnvironmentExtra' @('NODE_ENV=production', "SKALI_INITIAL_ALLOWLIST=$($AllowIp -join ',')") -DryRun:$DryRun

# 7. Firewall for the web UI: Private profile, local subnet only, node.exe only.
try {
    $profiles = @(Get-NetConnectionProfile -ErrorAction Stop)
    foreach ($p in $profiles | Where-Object { $_.NetworkCategory -eq 'Public' }) {
        Write-Warning "Network '$($p.Name)' is on the Public profile: the Private-only rule '$webRule' will not apply, so the UI would be unreachable from other PCs. Set it to Private (Settings > Network)."
    }
    if (-not ($profiles | Where-Object { $_.NetworkCategory -eq 'Private' })) { Write-Warning 'No active Private network profile was found.' }
} catch { Write-Host "Could not read the network profile: $($_.Exception.Message)" }
Invoke-Step "Replacing firewall rule '$webRule' (inbound TCP $port, Profile Private, RemoteAddress LocalSubnet, program $nodeArg)" {
    Get-NetFirewallRule -DisplayName $webRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $webRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port `
        -Profile Private -RemoteAddress LocalSubnet -Program $node | Out-Null
} -DryRun:$DryRun

# 8. Start and verify
Start-ServiceAndWait $serviceName -DryRun:$DryRun
if ($DryRun) {
    Write-Host "[dry-run] GET http://127.0.0.1:$port/api/games must return 200 (retried for up to 60 s)"
    Write-Host "[dry-run] Verifying data dir ACL (secret.key and skali.db inherit it; no ACE for any principal other than SYSTEM and Administrators)"
} else {
    $ok = $false
    $deadline = (Get-Date).AddSeconds(60)
    $lastError = ''
    while ((Get-Date) -lt $deadline -and -not $ok) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/games" -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $ok = $true } else { $lastError = "status $($r.StatusCode)" }
        } catch { $lastError = $_.Exception.Message }
        if (-not $ok) { Start-Sleep -Seconds 1 }
    }
    if (-not $ok) { throw "GET http://127.0.0.1:$port/api/games did not return 200 ($lastError). Check $serviceLog." }
    Write-Host "GET /api/games returned 200"
    Assert-DataDirAcl $dataDir
    Get-Service $serviceName
    Write-Host "Skali is running. Open http://192.168.0.100:$port from an allowed PC ($($AllowIp -join ', '))."
}
