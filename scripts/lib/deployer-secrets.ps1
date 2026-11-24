# The GitHub token and the API token under <Root>\deployer. Both are admin/SYSTEM-only by inheritance from the locked
# root (Skali runs as LocalSystem, so it can read the API token). Ported from Home (scripts/lib/deployer-secrets.ps1):
# no LocalService grants, no .env. Dot-source after common.ps1, acl.ps1 and deployer-paths.ps1; do not run.

# Writes $Text (ASCII, no BOM, no newline) into a file under the locked root, then checks it inherited only
# SYSTEM/Administrators. No part of the path may be a link.
function Write-SecretFile([string]$Root, [string]$Path, [string]$Text) {
    Assert-NoLinkChain $Root $Path
    [IO.File]::WriteAllText($Path, $Text, [Text.Encoding]::ASCII)
    Assert-OwnerTrusted $Path
    $v = @(Get-AclViolations $Path)
    if ($v) { throw "$Path has $($v -join ', '); it must inherit SYSTEM + Administrators only from the deploy root." }
}

function Read-SecretText([string]$Path) { ([IO.File]::ReadAllText($Path)).Trim() }

# An empty or whitespace-only file (a failed earlier write) counts as missing, so a re-run can retry.
function Test-SecretPresent([string]$Path) {
    (Get-PathState $Path) -eq 'File' -and -not [string]::IsNullOrWhiteSpace([IO.File]::ReadAllText($Path))
}

# Asks once, hidden (never echoed, never in argv or the transcript); keeps an existing token unless -NewToken.
# Never prompts in a dry run.
function Initialize-GitHubToken([string]$Root, [string]$File, [switch]$NewToken, [switch]$DryRun) {
    if ($DryRun) {
        if (-not $NewToken -and (Get-PathState $File) -eq 'File') { Write-Host "[dry-run] GitHub token already stored at $File; would keep it" }
        else { Write-Host "[dry-run] would ask for the GitHub token (Read-Host -AsSecureString, hidden) and store it in $File (inherits SYSTEM + Administrators only)" }
        return
    }
    if (-not $NewToken -and (Test-SecretPresent $File)) { Write-Host "GitHub token already stored at $File (re-run with -NewToken to replace it)"; return }
    $secure = Read-Host 'GitHub fine-grained token (repo Gabrielmong/skali; Contents: read, Actions: read)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $plain = "$plain".Trim()
    if (-not $plain) { throw 'No token entered.' }
    if ($plain -match '\s') { throw 'The token contains whitespace; paste only the token.' }
    Write-SecretFile $Root $File $plain
    $plain = $null
    Write-Host "GitHub token stored at $File"
}

# 32 random bytes as lowercase hex; kept when it already exists (Skali's service settings point at the file).
function Initialize-ApiToken([string]$Root, [string]$File, [switch]$DryRun) {
    if ($DryRun) {
        if ((Get-PathState $File) -eq 'File') { Write-Host "[dry-run] API token already exists at $File; would keep it" }
        else { Write-Host "[dry-run] would generate the API token (32 random bytes, hex) in $File (inherits SYSTEM + Administrators only)" }
        return
    }
    if (Test-SecretPresent $File) { Write-Host "API token already exists at $File"; return }
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    Write-SecretFile $Root $File (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    Write-Host "API token generated at $File"
}
