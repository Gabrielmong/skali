# The Skali service definition, shared by install-service.ps1 and apply-service-settings.ps1.
# Dot-source after common.ps1 and service.ps1; do not run.

# Applies every NSSM value of the Skali service for the app in $AppDirectory (the repo clone, or <Root>\current).
# Never starts, stops or restarts the service.
#  -InitialAllowlist  comma-separated SKALI_INITIAL_ALLOWLIST value; empty = leave that entry out.
#  -TokenFile         value for SKALI_DEPLOYER_TOKEN_FILE; empty = leave that entry out.
#  -InstallIfMissing  create the service (install-service.ps1 only); otherwise a missing service is an error.
function Set-SkaliServiceSettings([string]$Service, [string]$AppDirectory, [string]$Node, [string]$InitialAllowlist = '', [string]$TokenFile = '', [switch]$InstallIfMissing, [switch]$DryRun) {
    # NSSM stores AppParameters verbatim (no quoting), so use a path relative to AppDirectory: it never contains spaces.
    $mainJsRelative = 'apps\server\dist\main.js'
    $serviceLog = 'C:\ProgramData\Skali\service.log'
    if (Get-Service $Service -ErrorAction SilentlyContinue) {
        Set-NssmValue $Service 'Application' $Node -DryRun:$DryRun
        Set-NssmValue $Service 'AppParameters' $mainJsRelative -DryRun:$DryRun
    } elseif ($InstallIfMissing) {
        Invoke-Step "nssm install $Service $Node $mainJsRelative" { nssm install $Service $Node $mainJsRelative | Out-Null } -DryRun:$DryRun
    } else {
        $missing = "Service $Service is not installed; run install-service.ps1 / install-deployer.ps1"
        if ($DryRun) { Write-Host "[dry-run] would fail: $missing" } else { throw $missing }
        Set-NssmValue $Service 'Application' $Node -DryRun:$DryRun
        Set-NssmValue $Service 'AppParameters' $mainJsRelative -DryRun:$DryRun
    }
    Set-NssmValue $Service 'AppDirectory' $AppDirectory -DryRun:$DryRun
    Set-NssmValue $Service 'ObjectName' 'LocalSystem' -DryRun:$DryRun
    Set-NssmValue $Service 'Start' 'SERVICE_AUTO_START' -DryRun:$DryRun
    Set-NssmValue $Service 'AppKillProcessTree' '0' -DryRun:$DryRun
    Set-NssmValue $Service 'AppStopMethodConsole' '15000' -DryRun:$DryRun
    Set-NssmValues $Service 'AppExit' @('Default', 'Restart') -DryRun:$DryRun
    Set-NssmValue $Service 'AppRestartDelay' '5000' -DryRun:$DryRun
    Set-NssmValue $Service 'AppStdout' $serviceLog -DryRun:$DryRun
    Set-NssmValue $Service 'AppStderr' $serviceLog -DryRun:$DryRun
    Set-NssmValue $Service 'AppRotateFiles' '1' -DryRun:$DryRun
    Set-NssmValue $Service 'AppRotateBytes' '10485760' -DryRun:$DryRun
    # NODE_ENV=production makes the server serve the built web app. The allowlist only seeds a NEW database.
    $environment = @('NODE_ENV=production', "SKALI_PORT=$SkaliPort")
    if ($InitialAllowlist) { $environment += "SKALI_INITIAL_ALLOWLIST=$InitialAllowlist" }
    if ($TokenFile) { $environment += "SKALI_DEPLOYER_TOKEN_FILE=$TokenFile" }
    Set-NssmValues $Service 'AppEnvironmentExtra' $environment -DryRun:$DryRun
}

# Pure parser: the SKALI_INITIAL_ALLOWLIST=... entry from `nssm get <svc> AppEnvironmentExtra` output, or ''.
# nssm may print UTF-16 read as ANSI (NUL-interleaved), a BOM, and CRLF; all are stripped.
function Get-AllowlistEntry([string]$Text) {
    $clean = ($Text -replace "`0", '' -replace [string][char]0xFEFF, '' -replace "`r", '')
    foreach ($line in $clean -split "`n") {
        $line = $line.Trim()
        if ($line -match '^SKALI_INITIAL_ALLOWLIST=(.*)$') { return $line }
    }
    ''
}

# The SKALI_INITIAL_ALLOWLIST value currently stored in the service (NSSM replaces the whole AppEnvironmentExtra list,
# so a caller that doesn't know the allowlist must carry it over). Returns '' when the service or entry is absent.
function Get-ExistingInitialAllowlist([string]$Service) {
    if (-not (Get-Service $Service -ErrorAction SilentlyContinue)) { return '' }
    $global:LASTEXITCODE = 0
    $text = (@(& nssm get $Service AppEnvironmentExtra 2>$null | ForEach-Object { "$_" }) -join "`n")
    if ($LASTEXITCODE -ne 0) { throw "nssm get $Service AppEnvironmentExtra failed (exit code $LASTEXITCODE)" }
    $entry = Get-AllowlistEntry $text
    if ($entry) { return $entry.Substring('SKALI_INITIAL_ALLOWLIST='.Length) }
    ''
}
