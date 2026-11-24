# ACL hardening for Skali. Dot-source after common.ps1; do not run.
# SIDs: S-1-5-32-544 Administrators, S-1-5-18 SYSTEM, S-1-1-0 Everyone, S-1-5-11 Authenticated Users, S-1-5-32-545 Users.

$script:Admins = '*S-1-5-32-544'
$script:System = '*S-1-5-18'
$script:BroadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')

# Runs icacls without letting per-item errors stop the script. Windows PowerShell 5.1 turns redirected
# native stderr into a terminating error under $ErrorActionPreference='Stop', so this scope uses Continue.
# Returns the exit code and the number of items icacls reported as failed.
function Invoke-IcaclsTolerant([string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $out = & icacls @Arguments 2>&1 | ForEach-Object { "$_" }
    $exitCode = $LASTEXITCODE
    $failedLine = $out | Where-Object { $_ -match 'Failed processing (\d+)' } | Select-Object -Last 1
    $failed = if ($failedLine -and $failedLine -match 'Failed processing (\d+)') { [int]$Matches[1] } else { 0 }
    [pscustomobject]@{ ExitCode = $exitCode; Failed = $failed; Output = $out }
}

# Owner SID of a path. An owner keeps an implicit WRITE_DAC, so after the DACL rewrite the owner must be a
# trusted principal (Administrators or SYSTEM), not the user who ran the installer.
function Get-OwnerSid([string]$Path) {
    (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
}

function Assert-OwnerTrusted([string]$Path) {
    $owner = Get-OwnerSid $Path
    if ($owner -notin 'S-1-5-32-544', 'S-1-5-18') { throw "$Path is owned by $owner; it must be owned by Administrators (S-1-5-32-544) or SYSTEM (S-1-5-18)." }
}

function Get-AclSids([string]$Path) {
    (Get-Acl -LiteralPath $Path).Access | ForEach-Object {
        [pscustomobject]@{ Sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; Rights = $_.FileSystemRights.ToString(); Type = $_.AccessControlType; Inherited = $_.IsInherited }
    }
}

# Repo dir: LocalSystem runs code from it, so only admins and SYSTEM may change it; no inherited user access.
# /C keeps going past unreadable children (long paths etc.); a failed child only warns, a wrong root throws.
function Protect-RepoDirectory([string]$Repo, [switch]$DryRun) {
    $desc = "icacls $Repo /setowner Administrators /T /C, then /inheritance:r /C (admins/SYSTEM full control only)"
    if ($DryRun) { Write-Host "[dry-run] $desc"; return }
    Write-Host $desc
    $owned = Invoke-IcaclsTolerant @($Repo, '/setowner', $script:Admins, '/T', '/C')
    if ($owned.ExitCode -ne 0 -or $owned.Failed -gt 0) { Write-Warning "icacls /setowner exit code $($owned.ExitCode), $($owned.Failed) item(s) failed; checking the repo root owner next." }
    $result = Invoke-IcaclsTolerant @($Repo, '/inheritance:r', '/C', '/grant:r', "$($script:Admins):(OI)(CI)F", "$($script:System):(OI)(CI)F")
    if ($result.ExitCode -ne 0 -or $result.Failed -gt 0) {
        Write-Warning "icacls exit code $($result.ExitCode), $($result.Failed) item(s) failed; checking the repo root ACL next."
    }
    Assert-RepoRootAcl $Repo
}

# Throws unless the repo root grants exactly the intended access.
function Assert-RepoRootAcl([string]$Repo) {
    $rules = @(Get-AclSids $Repo)
    $has = { param($s) [bool]($rules | Where-Object { $_.Sid -eq $s -and $_.Type -eq 'Allow' -and $_.Rights -match 'FullControl' }) }
    $problems = @()
    if (-not (& $has 'S-1-5-32-544')) { $problems += 'Administrators lack full control' }
    if (-not (& $has 'S-1-5-18')) { $problems += 'SYSTEM lacks full control' }
    try { Assert-OwnerTrusted $Repo } catch { $problems += $_.Exception.Message }
    $writers = $rules | Where-Object { $_.Sid -in $script:BroadSids -and $_.Type -eq 'Allow' -and $_.Rights -match 'Write|Modify|FullControl' }
    if ($writers) { $problems += 'Users/Authenticated Users/Everyone still have write access' }
    if ($problems) { throw "Repo root ACL is wrong: $($problems -join '; ')" }
}

# Data dir (secret key, database): SYSTEM and Administrators full control, inheritance disabled.
# Must run before the service first starts, so the files the service creates inherit it.
function Protect-DataDirectory([string]$Dir, [switch]$DryRun) {
    Invoke-Step "icacls $Dir /setowner Administrators /T /C, then /inheritance:r (SYSTEM + Administrators full control only)" {
        $owned = Invoke-IcaclsTolerant @($Dir, '/setowner', $script:Admins, '/T', '/C')
        if ($owned.ExitCode -ne 0) { throw "icacls /setowner failed (exit code $($owned.ExitCode)): $($owned.Output -join ' ')" }
        $result = Invoke-IcaclsTolerant @($Dir, '/inheritance:r', '/grant:r', "$($script:Admins):(OI)(CI)F", "$($script:System):(OI)(CI)F")
        if ($result.ExitCode -ne 0) { throw "icacls failed (exit code $($result.ExitCode)): $($result.Output -join ' ')" }
    } -DryRun:$DryRun
}

# Throws unless the data dir grants only SYSTEM + Administrators and any existing key/database inherit that.
function Assert-DataDirAcl([string]$Dir) {
    $problems = @()
    $rules = @(Get-AclSids $Dir)
    if (-not ($rules | Where-Object { $_.Sid -eq 'S-1-5-18' -and $_.Rights -match 'FullControl' })) { $problems += 'SYSTEM lacks full control on the data dir' }
    if (-not ($rules | Where-Object { $_.Sid -eq 'S-1-5-32-544' -and $_.Rights -match 'FullControl' })) { $problems += 'Administrators lack full control on the data dir' }
    if ($rules | Where-Object { $_.Sid -in $script:BroadSids }) { $problems += 'Users/Authenticated Users/Everyone have an ACE on the data dir' }
    try { Assert-OwnerTrusted $Dir } catch { $problems += $_.Exception.Message }
    if ((Get-Acl -LiteralPath $Dir).AreAccessRulesProtected -ne $true) { $problems += 'data dir still inherits permissions from its parent' }
    foreach ($name in 'secret.key', 'skali.db') {
        $file = Join-Path $Dir $name
        if (-not (Test-Path -LiteralPath $file)) { continue }
        try { Assert-OwnerTrusted $file } catch { $problems += $_.Exception.Message }
        $fileRules = @(Get-AclSids $file)
        if ($fileRules | Where-Object { $_.Sid -in $script:BroadSids }) { $problems += "$name has a Users/Authenticated Users/Everyone ACE" }
        if ($fileRules | Where-Object { -not $_.Inherited }) { $problems += "$name has explicit (non-inherited) ACEs" }
        if ($fileRules | Where-Object { $_.Sid -notin 'S-1-5-18', 'S-1-5-32-544' }) { $problems += "$name grants access beyond SYSTEM and Administrators" }
    }
    if ($problems) { throw "Data dir ACL is wrong: $($problems -join '; ')" }
    Write-Host 'Data dir ACL verified: only SYSTEM and Administrators, inheritance disabled.'
}
