# NSSM / Windows service helpers. Dot-source after common.ps1; do not run.

function Set-NssmValue([string]$Service, [string]$Key, [string]$Value, [switch]$DryRun) {
    Invoke-Step "nssm set $Key = $Value" { nssm set $Service $Key $Value | Out-Null } -DryRun:$DryRun
}

# Multi-part nssm settings, each part its own argument: AppEnvironmentExtra (one KEY=VALUE each), AppExit (code, action).
function Set-NssmValues([string]$Service, [string]$Key, [string[]]$Values, [switch]$DryRun) {
    Invoke-Step "nssm set $Key = $($Values -join ' ')" { nssm set $Service $Key @Values | Out-Null } -DryRun:$DryRun
}

# Stops the service (also when StopPending) and waits until it is Stopped; throws if it never stops.
# Game servers run detached, so stopping Skali never stops them.
function Stop-ServiceIfRunning([string]$Service, [int]$TimeoutSeconds = 20, [switch]$DryRun) {
    $svc = Get-Service $Service -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -eq 'Stopped') { return }
    if ($svc.Status -ne 'StopPending') {
        Invoke-Step "Stopping $Service (game servers keep running)" { nssm stop $Service | Out-Null } -DryRun:$DryRun
    }
    if ($DryRun) { return }
    try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($TimeoutSeconds)) }
    catch { throw "$Service did not stop within $TimeoutSeconds s." }
}

function Start-ServiceAndWait([string]$Service, [int]$TimeoutSeconds = 20, [switch]$DryRun) {
    Invoke-Step "Starting $Service" { nssm start $Service | Out-Null } -DryRun:$DryRun
    if ($DryRun) { Write-Host "[dry-run] Waiting up to $TimeoutSeconds s for $Service to be Running"; return }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-Service $Service).Status -eq 'Running') { Write-Host "$Service is Running"; return }
        Start-Sleep -Milliseconds 500
    }
    throw "$Service is not Running after $TimeoutSeconds s. Check C:\ProgramData\Skali\service.log."
}
