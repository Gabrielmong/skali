<#
.SYNOPSIS
  Removes the NSSM service "Skali" and its web firewall rule. Running game servers are NEVER stopped.
  With -Purge it also deletes C:\ProgramData\Skali (database, secret key, logs), every 'Skali - *' game firewall
  rule and the SkaliGames user. Use -DryRun to preview (changes nothing, needs no elevation).
.NOTES
  Game folders and saves are never touched.
#>
param([switch]$Purge, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot\lib\common.ps1"
. "$PSScriptRoot\lib\service.ps1"

$serviceName = 'Skali'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$dataDir = 'C:\ProgramData\Skali'
$webRule = 'Skali web (TCP 4100)'
$gamesUser = 'SkaliGames'

Assert-Admin -DryRun:$DryRun
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    if ($DryRun) { Write-Host '[dry-run] would fail: nssm was not found. Run: choco install nssm' } else { throw 'nssm was not found. Run: choco install nssm' }
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

Stop-ServiceIfRunning $serviceName -DryRun:$DryRun
if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
    Invoke-Step "nssm remove $serviceName confirm" { nssm remove $serviceName confirm | Out-Null } -DryRun:$DryRun
} else { Write-Host "Service $serviceName is not installed." }
Invoke-Step "Removing firewall rule '$webRule'" {
    Get-NetFirewallRule -DisplayName $webRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
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
