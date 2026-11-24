<#
.SYNOPSIS
  Removes the NSSM service "Skali" and its web firewall rule. Running game servers are NEVER stopped.
  With -Purge it also deletes C:\ProgramData\Skali (database, secret key, logs), every 'Skali - *' game firewall
  rule and the SkaliGames user. Use -DryRun to preview (changes nothing, needs no elevation).
.PARAMETER Deployer
  Remove the deploy helper instead: stop and remove the SkaliDeployer service (the Skali service, the data dir and games
  are left alone). With -Purge also delete the deploy root (-DeployRoot, default C:\SkaliDeploy: releases, the repo clone,
  tokens, deploy history, logs and database backups); refused while the Skali service still runs from inside it.
.NOTES
  Game folders and saves are never touched.
#>
param([switch]$Purge, [switch]$Deployer, [string]$DeployRoot = 'C:\SkaliDeploy', [switch]$DryRun)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot\lib\common.ps1"
. "$PSScriptRoot\lib\service.ps1"

$serviceName = 'Skali'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$dataDir = 'C:\ProgramData\Skali'
$webRule = 'Skali web (TCP 4200)'
$legacyWebRule = 'Skali web (TCP 4100)'
$gamesUser = 'SkaliGames'
$deployerService = 'SkaliDeployer'

Assert-Admin -DryRun:$DryRun
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    if ($DryRun) { Write-Host '[dry-run] would fail: nssm was not found. Run: choco install nssm' } else { throw 'nssm was not found. Run: choco install nssm' }
}

if ($Deployer) {
    . "$PSScriptRoot\lib\deployer-paths.ps1"
    if ($DeployRoot -notmatch '^[A-Za-z]:\\[^\s]+$') { throw "-DeployRoot must be an absolute folder path without spaces: '$DeployRoot'" }
    $DeployRoot = Get-FullPath $DeployRoot
    if ($Purge) {
        # Checked BEFORE the helper is touched: Skali must not run from a folder that is about to disappear, and a refused
        # purge leaves everything as it was. Fail closed: if the Skali service exists, its AppDirectory must be readable.
        if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
            $appDir = ''
            $code = 1
            if (Get-Command nssm -ErrorAction SilentlyContinue) {
                $ErrorActionPreference = 'Continue'
                $global:LASTEXITCODE = 0
                $appDir = ((@(& nssm get $serviceName AppDirectory 2>$null | ForEach-Object { "$_" }) -join '') -replace "`0", '' -replace [string][char]0xFEFF, '').Trim()
                $code = $LASTEXITCODE
                $ErrorActionPreference = 'Stop'
            }
            if ($code -ne 0 -or -not $appDir) {
                $msg = "Refusing to delete ${DeployRoot}: could not read the $serviceName service's AppDirectory (nssm get $serviceName AppDirectory), so it may still run from inside it. Fix nssm, or remove $serviceName first, then re-run."
                if ($DryRun) { Write-Host "[dry-run] would fail: $msg"; return }
                throw $msg
            }
            Write-Host "$serviceName AppDirectory: $appDir"
            $inside = [string]::Equals($appDir.TrimEnd('\'), $DeployRoot, [StringComparison]::OrdinalIgnoreCase) -or
                $appDir.StartsWith($DeployRoot + '\', [StringComparison]::OrdinalIgnoreCase)
            if ($inside) {
                $msg = "Refusing to delete ${DeployRoot}: the $serviceName service runs from $appDir. Re-run install-service.ps1 from the clone (for example C:\skali) first, so Skali runs from the clone again, then re-run this. Nothing was changed."
                if ($DryRun) { Write-Host "[dry-run] would fail: $msg"; return }
                throw $msg
            }
        }
    }
    # The helper finishes a running deploy before it exits (up to 11 min).
    Stop-ServiceIfRunning $deployerService -TimeoutSeconds 700 -DryRun:$DryRun
    if (Get-Service $deployerService -ErrorAction SilentlyContinue) {
        Invoke-Step "nssm remove $deployerService confirm" { nssm remove $deployerService confirm | Out-Null } -DryRun:$DryRun
    } else { Write-Host "Service $deployerService is not installed." }
    if (-not $Purge) {
        Write-Host "Left in place: $DeployRoot (use -Deployer -Purge to delete it) and the Skali service."
        return
    }
    if ((Get-PathState $DeployRoot) -eq 'Missing') { Write-Host "$DeployRoot does not exist."; return }
    if ((Get-PathState $DeployRoot) -ne 'Dir') { throw "$DeployRoot is a link or a file, not the deploy root; remove it yourself after checking it." }
    Write-Warning "-Purge deletes $DeployRoot, including the database backups in $(Join-Path $DeployRoot 'deployer\backups'). Copy any you want to keep first."
    # cmd's rmdir /s /q removes the `current` junction and node_modules junctions without following them.
    Invoke-Step "Deleting $DeployRoot (cmd rmdir /s /q, junctions are not followed)" {
        & cmd.exe /c rmdir /s /q "`"$DeployRoot`""
        if ((Get-PathState $DeployRoot) -ne 'Missing') { throw "Could not delete $DeployRoot completely." }
    } -DryRun:$DryRun
    return
}

# Best effort: names and pids of servers the database says are running and whose process is alive.
function Get-RunningGames {
    $db = Join-Path $dataDir 'skali.db'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $db) -or -not $node) { return @() }
    try {
        $env:SKALI_DB = $db
        $script = "const D=require('better-sqlite3');const d=new D(process.env.SKALI_DB,{readonly:true});" +
            "for(const r of d.prepare('SELECT name,pid FROM servers WHERE pid IS NOT NULL').all())console.log(r.pid+'`t'+r.name);d.close()"
        Push-Location (Join-Path $repo 'apps\server')
        try { $lines = @(& $node.Source -e $script 2>$null) } finally { Pop-Location; Remove-Item Env:\SKALI_DB -ErrorAction SilentlyContinue }
        $lines | ForEach-Object {
            $pidText, $name = $_ -split "`t", 2
            if (Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue) { "$name (pid $pidText)" }
        }
    } catch { @() }
}

$running = @(Get-RunningGames)
if ($running.Count -gt 0) {
    Write-Warning "These game servers appear to be running and will KEEP RUNNING (this script never stops them): $($running -join ', ')"
} else {
    Write-Warning 'Game servers started by Skali run detached and keep running after Skali is removed. This script never stops them; stop them from the UI first if you want them down.'
}
if ($Purge) { Write-Warning "-Purge deletes the database and secret key in ${dataDir}: stored server passwords can no longer be decrypted, and Skali forgets all servers." }
if (Get-Service $deployerService -ErrorAction SilentlyContinue) {
    Write-Warning "The deploy helper ($deployerService) is installed and would start Skali again; remove it too: uninstall-service.ps1 -Deployer [-Purge]."
}

Stop-ServiceIfRunning $serviceName -DryRun:$DryRun
if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
    Invoke-Step "nssm remove $serviceName confirm" { nssm remove $serviceName confirm | Out-Null } -DryRun:$DryRun
} else { Write-Host "Service $serviceName is not installed." }
Invoke-Step "Removing firewall rules '$webRule' and legacy '$legacyWebRule'" {
    Get-NetFirewallRule -DisplayName $webRule, $legacyWebRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
} -DryRun:$DryRun

if ($Purge) {
    # Each purge step runs on its own so one failure (e.g. a game holding a log open) doesn't skip the rest.
    $failures = @()
    function Invoke-PurgeStep([string]$Description, [scriptblock]$Action) {
        try { Invoke-Step $Description $Action -DryRun:$DryRun } catch { $script:failures += "${Description}: $($_.Exception.Message)"; Write-Warning "Failed: $Description ($($_.Exception.Message))" }
    }
    Invoke-PurgeStep "Removing firewall rules in group 'Skali' named 'Skali - *'" {
        Get-NetFirewallRule -Group 'Skali' -ErrorAction SilentlyContinue |
            Where-Object { ([string]$_.DisplayName).StartsWith('Skali - ', [StringComparison]::Ordinal) } |
            Remove-NetFirewallRule
    }
    Invoke-PurgeStep "Deleting local user $gamesUser and its Windows profile (C:\Users\$gamesUser, if one was ever created)" {
        $u = Get-LocalUser -Name $gamesUser -ErrorAction SilentlyContinue
        if ($u) {
            $sid = $u.SID.Value
            Remove-LocalUser -Name $gamesUser
            Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | Remove-CimInstance
        }
    }
    Invoke-PurgeStep "Deleting $dataDir" {
        if (Test-Path -LiteralPath $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force }
    }
    if ($failures.Count -gt 0) { throw "Purge incomplete:`n  $($failures -join "`n  ")" }
} else {
    Write-Host "Left in place: $dataDir, game folders and 'Skali - *' firewall rules (use -Purge to remove the first and last)."
}
