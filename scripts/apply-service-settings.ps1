<#
.SYNOPSIS
  Applies the Skali service definition for the deployed layout (AppDirectory = <Root>\current junction).
  Run by the deployer from the release's own copy of scripts\, as LocalSystem. Does not start, stop or restart the service.
  An existing SKALI_INITIAL_ALLOWLIST entry is preserved. -DryRun prints every NSSM value and changes nothing.
.PARAMETER AppDirectory
  Only for a failed setup bootstrap (install-deployer.ps1): point Skali back at the existing install it ran from
  (install-service.ps1's settings, AppDirectory = that clone) instead of <Root>\current.
#>
param(
    [Parameter(Mandatory)][string]$Service,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Node,
    [string]$AppDirectory = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot\lib\common.ps1"
. "$PSScriptRoot\lib\service.ps1"
. "$PSScriptRoot\lib\service-settings.ps1"

try {
    if ($Root -match '\s') { throw "-Root must not contain spaces (NSSM stores paths unquoted): '$Root'" }
    if (-not $DryRun -and -not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw "-Node does not exist: $Node" }
    if ($AppDirectory -match '\s') { throw "-AppDirectory must not contain spaces (NSSM stores paths unquoted): '$AppDirectory'" }
    $current = if ($AppDirectory) { $AppDirectory } else { Join-Path $Root 'current' }
    $mainJs = Join-Path $current 'apps\server\dist\main.js'
    if (-not $DryRun -and -not (Test-Path -LiteralPath $mainJs -PathType Leaf)) { throw "Missing $mainJs (is $current a built Skali install?)" }
    Assert-Admin -DryRun:$DryRun
    if (-not $DryRun -or (Test-Path -LiteralPath $Node)) { Test-NodeIsSystemWide $Node -DryRun:$DryRun }
    if (-not $DryRun -and -not (Get-Command nssm -ErrorAction SilentlyContinue)) { throw 'nssm was not found. Run: choco install nssm' }

    if ($DryRun) {
        Write-Host '[dry-run] reading the existing SKALI_INITIAL_ALLOWLIST from the service (nssm get) and keeping it, if present'
        $allowlist = ''
    } else {
        $allowlist = Get-ExistingInitialAllowlist $Service
    }
    $tokenFile = Join-Path $Root 'deployer\api-token'
    Set-SkaliServiceSettings -Service $Service -AppDirectory $current -Node $Node -InitialAllowlist $allowlist -TokenFile $tokenFile -DryRun:$DryRun
    Write-Host "Service settings applied to $Service"
} catch {
    [Console]::Error.WriteLine("apply-service-settings failed: $($_.Exception.Message)")
    exit 1
}
