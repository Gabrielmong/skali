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
    if ($owner -notin $script:TrustedSids) { throw "$Path is owned by $owner; it must be owned by Administrators (S-1-5-32-544) or SYSTEM (S-1-5-18)." }
}

# SID string of an ACE identity. An untranslatable account stays as its raw value, which is never a trusted SID.
function ConvertTo-SidString($Identity) {
    try { $Identity.Translate([Security.Principal.SecurityIdentifier]).Value } catch { "$($Identity.Value)" }
}

$script:TrustedSids = @('S-1-5-18', 'S-1-5-32-544')

# SIDs of every ACE on $Path (inherited or explicit) that is not SYSTEM or Administrators. Allowlist, not a denylist.
function Get-UntrustedAclSids([string]$Path) {
    @(Get-AclSids $Path | Where-Object { $_.Sid -notin $script:TrustedSids } | ForEach-Object { $_.Sid } | Select-Object -Unique)
}

# Removes every EXPLICIT ACE on $Path whose SID is not SYSTEM or Administrators. icacls /grant:r replaces only the ACEs of
# the principals it names, so without this an ACE a squatter added for their own account would survive the lockdown.
# Needs WRITE_DAC (Administrators or the owner). Inherited ACEs are left for /inheritance:r to drop.
# Returns the number of ACEs removed (or that would be removed under -DryRun).
function Remove-UntrustedExplicitAces([string]$Path, [switch]$DryRun) {
    $item = Get-Item -LiteralPath $Path -Force   # Access section only: Set-Acl would also write owner/SACL and need SeSecurityPrivilege
    $acl = $item.GetAccessControl('Access')
    $removed = 0
    # Rules are requested as SIDs, so untranslatable accounts need no lookup and removal matches the stored ACE exactly.
    foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
        $sid = ConvertTo-SidString $rule.IdentityReference
        if ($sid -in $script:TrustedSids) { continue }
        $removed++
        if ($DryRun) { Write-Host "[dry-run] would remove explicit ACE on ${Path}: $($rule.IdentityReference) ($sid) $($rule.AccessControlType) $($rule.FileSystemRights)"; continue }
        Write-Host "Removing explicit ACE on ${Path}: $($rule.IdentityReference) ($sid) $($rule.AccessControlType) $($rule.FileSystemRights)"
        $acl.RemoveAccessRuleSpecific($rule)   # void in Windows PowerShell 5.1; success is verified below
    }
    if ($removed -gt 0 -and -not $DryRun) {
        $item.SetAccessControl($acl)
        $left = @($item.GetAccessControl('Access').GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object { (ConvertTo-SidString $_.IdentityReference) -notin $script:TrustedSids })
        if ($left) { throw "Explicit ACEs for other principals remain on ${Path}: $($left.IdentityReference -join ', ')" }
    }
    $removed
}

function Get-AclSids([string]$Path) {
    (Get-Acl -LiteralPath $Path).Access | ForEach-Object {
        [pscustomobject]@{ Sid = (ConvertTo-SidString $_.IdentityReference); Rights = $_.FileSystemRights.ToString(); Type = $_.AccessControlType; Inherited = $_.IsInherited }
    }
}

# pnpm's default is to HARD-LINK files from its global store into node_modules. NTFS keeps ONE security descriptor
# per file, shared by every link, so (a) the lockdown below would rewrite the ACL of the store's files and of every
# other project linked to them, and (b) a file the lockdown just protected can still be edited through the store's
# (user-writable) link. The repo .npmrc sets package-import-method=copy so install makes private copies instead.

# The node_modules folders of the workspace (root plus each app/package).
function Get-NodeModulesDirs([string]$Repo) {
    $dirs = @(Join-Path $Repo 'node_modules')
    foreach ($group in 'apps', 'packages') {
        $g = Join-Path $Repo $group
        if (Test-Path -LiteralPath $g) { $dirs += @(Get-ChildItem -LiteralPath $g -Directory | ForEach-Object { Join-Path $_.FullName 'node_modules' }) }
    }
    @($dirs | Where-Object { Test-Path -LiteralPath $_ })
}

# True when files under node_modules\.pnpm have more than one hard link (samples up to $Sample files).
function Test-NodeModulesHardLinked([string]$Repo, [int]$Sample = 300) {
    $store = Join-Path $Repo 'node_modules\.pnpm'
    if (-not (Test-Path -LiteralPath $store)) { return $false }
    $files = Get-ChildItem -LiteralPath $store -Recurse -File -Depth 5 -ErrorAction SilentlyContinue | Select-Object -First $Sample
    [bool]($files | Where-Object { $_.LinkType -eq 'HardLink' } | Select-Object -First 1)
}

# Before `pnpm install`: a node_modules left by a hard-linking install is deleted so the install recreates it as copies.
# Deleting only removes this repo's links; the pnpm store and other projects are untouched. cmd's rmdir /s removes
# junctions without following them.
function Remove-HardLinkedNodeModules([string]$Repo, [switch]$DryRun) {
    $dirs = @(Get-NodeModulesDirs $Repo)
    if (-not $dirs) { Write-Host 'node_modules: none present, nothing to clean.'; return }
    if (-not (Test-NodeModulesHardLinked $Repo)) { Write-Host 'node_modules: no hard-linked files, keeping it.'; return }
    foreach ($d in $dirs) {
        if ($DryRun) { Write-Host "[dry-run] node_modules is hard-linked to the pnpm store: would delete $d (pnpm install then recreates it as copies)"; continue }
        Write-Host "node_modules is hard-linked to the pnpm store: deleting $d (pnpm install recreates it as copies)"
        & cmd.exe /c rmdir /s /q "`"$d`""
        if (Test-Path -LiteralPath $d) { throw "Could not delete $d" }
    }
}

# Throws when node_modules still has hard-linked files after install (so the lockdown would not hold).
function Assert-NodeModulesNotHardLinked([string]$Repo) {
    if (Test-NodeModulesHardLinked $Repo) { throw "node_modules still contains hard-linked files (check that .npmrc has package-import-method=copy), so the repo lockdown would not hold. Delete the node_modules folders and re-run." }
}

# ---- Reparse points, hard links, tree walking -------------------------------------------------------------------------
# A junction/symlink is never followed here: the walk checks Attributes before it descends. (Get-ChildItem -Recurse
# follows directory links on Windows PowerShell 5.1.)

if (-not ('SkaliNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SkaliNative {
    [StructLayout(LayoutKind.Sequential)] struct FT { public uint Lo, Hi; }
    [StructLayout(LayoutKind.Sequential)] struct BHFI { public uint Attr; public FT C, A, W; public uint Vol, SzHi, SzLo, Links, IdxHi, IdxLo; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle h, out BHFI info);
    // Number of hard links of a file. Opens with no access rights (attributes only) and never follows a link.
    public static int LinkCount(string path) {
        using (SafeFileHandle h = CreateFileW(@"\\?\" + path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (h.IsInvalid) throw new IOException("cannot open " + path, Marshal.GetLastWin32Error());
            BHFI i;
            if (!GetFileInformationByHandle(h, out i)) throw new IOException("cannot query " + path, Marshal.GetLastWin32Error());
            return (int)i.Links;
        }
    }
}
'@
}

function Test-IsReparsePoint([string]$Path) {
    [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# Walks $Root without following reparse points. Returns the reparse points found (not descended into), plus the
# directories and files below $Root unless -ReparseOnly.
function Get-TreeEntries([string]$Root, [switch]$ReparseOnly) {
    $reparse = New-Object 'System.Collections.Generic.List[string]'
    $dirs = New-Object 'System.Collections.Generic.List[string]'
    $files = New-Object 'System.Collections.Generic.List[string]'
    $stack = New-Object System.Collections.Generic.Stack[IO.DirectoryInfo]
    $stack.Push((New-Object IO.DirectoryInfo $Root))
    while ($stack.Count -gt 0) {
        $d = $stack.Pop()
        foreach ($e in $d.EnumerateFileSystemInfos()) {
            if ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) { $reparse.Add($e.FullName) }
            elseif ($e -is [IO.DirectoryInfo]) { if (-not $ReparseOnly) { $dirs.Add($e.FullName) }; $stack.Push($e) }
            elseif (-not $ReparseOnly) { $files.Add($e.FullName) }
        }
    }
    [pscustomobject]@{ Reparse = $reparse; Dirs = $dirs; Files = $files }
}

# Absolute target of a junction/symlink, or $null when it cannot be resolved.
function Get-ReparseTarget([string]$Path) {
    $t = @((Get-Item -LiteralPath $Path -Force).Target) | Where-Object { $_ } | Select-Object -First 1
    if (-not $t) { return $null }
    $t = "$t" -replace '^\\\?\?\\', ''
    if (-not [IO.Path]::IsPathRooted($t)) { $t = Join-Path (Split-Path $Path -Parent) $t }
    [IO.Path]::GetFullPath($t).TrimEnd('\')
}

function Test-PathInside([string]$Path, [string]$Root) {
    $r = $Root.TrimEnd('\')
    $Path -ieq $r -or $Path.StartsWith("$r\", [StringComparison]::OrdinalIgnoreCase)
}

# ---- ACL checks -------------------------------------------------------------------------------------------------------

# Violations of the allowlist on $Path: an ACE for any principal other than SYSTEM/Administrators, or a Deny ACE
# (even for those two). With -ExplicitOnly, inherited ACEs are ignored (for children of an already-checked root).
function Get-AclViolations([string]$Path, [switch]$ExplicitOnly) {
    $out = @()
    foreach ($a in @(Get-AclSids $Path)) {
        if ($ExplicitOnly -and $a.Inherited) { continue }
        if ($a.Sid -notin $script:TrustedSids) { $out += "ACE for $($a.Sid)" }
        elseif ($a.Type -ne 'Allow') { $out += "Deny ACE for $($a.Sid) (only Allow ACEs for SYSTEM/Administrators are accepted)" }
    }
    $out | Select-Object -Unique
}

# ---- Repo ------------------------------------------------------------------------------------------------------------

# Problems that make a recursive icacls over the repo unsafe: the root is a link, or a junction/symlink below it
# resolves outside the repo (icacls /T traverses links, and /L does not prevent that). Links that stay inside are fine.
function Get-RepoLinkProblems([string]$Repo) {
    $problems = @()
    if (Test-IsReparsePoint $Repo) { return @("$Repo is itself a junction/symlink") }
    foreach ($link in (Get-TreeEntries $Repo -ReparseOnly).Reparse) {
        $target = $null
        try { $target = Get-ReparseTarget $link } catch { }
        if (-not $target) { $problems += "$link is a reparse point whose target cannot be resolved" }
        elseif (-not (Test-PathInside $target $Repo)) { $problems += "$link points outside the repo ($target)" }
    }
    $problems
}

# Repo dir: LocalSystem runs code from it, so only admins and SYSTEM may change it; no inherited user access.
# Run AFTER `pnpm install` and the build, so the files they create are covered too.
# /C keeps going past unreadable children (long paths etc.); a failed child only warns, a wrong root throws.
# /L applies a change to a junction/symlink itself rather than to its target. It does NOT stop /T from traversing
# through junctions, so before any recursive icacls every link under the repo is enumerated and the install aborts if
# one resolves outside the repo root. pnpm's node_modules junctions point inside the repo, which is fine.
# Order: link check, setowner /T, strip the root's other explicit ACEs, inheritance:r + grant on the root, then
# `/reset /T` on the children so they inherit only from the locked root (no explicit ACE on a file a user created).
function Protect-RepoDirectory([string]$Repo, [switch]$DryRun) {
    $desc = "icacls $Repo /setowner Administrators /T /C /L, strip other explicit root ACEs, /inheritance:r /C /L + grant, then $Repo\* /reset /T /C /L (admins/SYSTEM only; /L acts on links themselves, /T still traverses them)"
    if ($DryRun) {
        Write-Host "[dry-run] checking that no junction/symlink under $Repo resolves outside it"
        try {
            $bad = @(Get-RepoLinkProblems $Repo)
            if ($bad) { Write-Host "[dry-run] would fail: $($bad -join '; ')" }
        } catch { Write-Host "[dry-run] would fail: cannot enumerate $Repo ($($_.Exception.Message))" }
        Write-Host "[dry-run] $desc"
        try { Remove-UntrustedExplicitAces $Repo -DryRun | Out-Null }
        catch { Write-Host "[dry-run] would fail: cannot read the ACL of $Repo ($($_.Exception.Message))" }
        return
    }
    $bad = @(Get-RepoLinkProblems $Repo)
    if ($bad) { throw "Refusing to run recursive icacls over the repo: $($bad -join '; ')" }
    Write-Host $desc
    $owned = Invoke-IcaclsTolerant @($Repo, '/setowner', $script:Admins, '/T', '/C', '/L')
    if ($owned.ExitCode -ne 0 -or $owned.Failed -gt 0) { Write-Warning "icacls /setowner exit code $($owned.ExitCode), $($owned.Failed) item(s) failed; checking the repo root owner next." }
    Remove-UntrustedExplicitAces $Repo | Out-Null
    $result = Invoke-IcaclsTolerant @($Repo, '/inheritance:r', '/C', '/L', '/grant:r', "$($script:Admins):(OI)(CI)F", "$($script:System):(OI)(CI)F")
    if ($result.ExitCode -ne 0 -or $result.Failed -gt 0) {
        Write-Warning "icacls exit code $($result.ExitCode), $($result.Failed) item(s) failed; checking the repo root ACL next."
    }
    $reset = Invoke-IcaclsTolerant @("$Repo\*", '/reset', '/T', '/C', '/L')
    if ($reset.ExitCode -ne 0 -or $reset.Failed -gt 0) { Write-Warning "icacls /reset exit code $($reset.ExitCode), $($reset.Failed) item(s) failed; the sampled child check below decides." }
    Assert-RepoRootAcl $Repo
}

# Throws unless the repo root grants SYSTEM and Administrators full control and nothing else (allowlist; Deny ACEs
# rejected), is owned by a trusted principal, and the sampled children carry no explicit ACE outside the allowlist.
# Sample: every top-level entry, plus the contents of apps/server/dist and tools/SkaliHelper/publish.
function Assert-RepoRootAcl([string]$Repo) {
    $rules = @(Get-AclSids $Repo)
    $has = { param($s) [bool]($rules | Where-Object { $_.Sid -eq $s -and $_.Type -eq 'Allow' -and $_.Rights -match 'FullControl' }) }
    $problems = @()
    if (-not (& $has 'S-1-5-32-544')) { $problems += 'Administrators lack full control' }
    if (-not (& $has 'S-1-5-18')) { $problems += 'SYSTEM lacks full control' }
    try { Assert-OwnerTrusted $Repo } catch { $problems += $_.Exception.Message }
    $v = @(Get-AclViolations $Repo)
    if ($v) { $problems += "the repo root has: $($v -join ', ')" }
    if ($problems) { throw "Repo root ACL is wrong: $($problems -join '; ')" }

    $sample = @(Get-ChildItem -LiteralPath $Repo -Force | ForEach-Object { $_.FullName })
    foreach ($sub in 'apps\server\dist', 'tools\SkaliHelper\publish') {
        $p = Join-Path $Repo $sub
        if (Test-Path -LiteralPath $p) { $sample += $p; $sample += @(Get-ChildItem -LiteralPath $p -Force | ForEach-Object { $_.FullName }) }
    }
    $bad = @()
    foreach ($s in $sample) {
        try { $cv = @(Get-AclViolations $s -ExplicitOnly) } catch { $bad += "$s (ACL unreadable: $($_.Exception.Message))"; continue }
        if ($cv) { $bad += "$s ($($cv -join ', '))" }
    }
    if ($bad) { throw "Repo children carry explicit ACEs outside SYSTEM/Administrators: $($bad -join '; ')" }
}

# ---- Data dir --------------------------------------------------------------------------------------------------------
# Trust it or refuse it; never repair it. A data dir that already exists before the installer made it may have been
# pre-created by a user: it can hold a chosen secret.key, a seeded database, open handles, hard links or junctions that
# no ACL change removes. So an existing dir is accepted only if it already satisfies every check below; otherwise the
# admin deletes it and the installer creates it fresh, atomically, with its final protected ACL.

# All reasons $Dir cannot be trusted (empty = trusted). Read-only. Root checks run first and the tree is walked only
# when they pass, so nothing is enumerated through a link. $StopAt is the highest ancestor checked for links.
function Get-DataDirProblems([string]$Dir, [string]$StopAt = (Split-Path $Dir -Parent)) {
    if (-not (Test-Path -LiteralPath $Dir)) { return @("$Dir does not exist") }
    $p = @()
    if (Test-IsReparsePoint $Dir) { $p += "$Dir is a junction/symlink" }
    $a = Split-Path $Dir -Parent
    while ($a) {
        if (Test-IsReparsePoint $a) { $p += "ancestor $a is a junction/symlink" }
        if ($a -ieq $StopAt) { break }
        $a = Split-Path $a -Parent
    }
    try { Assert-OwnerTrusted $Dir } catch { $p += $_.Exception.Message }
    if ((Get-Acl -LiteralPath $Dir).AreAccessRulesProtected -ne $true) { $p += 'the root ACL inherits from its parent' }
    $v = @(Get-AclViolations $Dir)
    if ($v) { $p += "the root ACL has: $($v -join ', ')" }
    $rules = @(Get-AclSids $Dir)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        if (-not ($rules | Where-Object { $_.Sid -eq $sid -and $_.Type -eq 'Allow' -and $_.Rights -match 'FullControl' })) { $p += "$sid lacks full control on the root" }
    }
    if ($p) { return $p }

    $tree = Get-TreeEntries $Dir
    foreach ($r in $tree.Reparse) { $p += "$r is a junction/symlink" }
    if ($p) { return $p }
    foreach ($f in @($tree.Dirs) + @($tree.Files)) {
        try { Assert-OwnerTrusted $f } catch { $p += $_.Exception.Message }
        $cv = @(Get-AclViolations $f -ExplicitOnly)
        if ($cv) { $p += "$f has explicit $($cv -join ', ')" }
    }
    foreach ($f in $tree.Files) {
        $n = [SkaliNative]::LinkCount($f)
        if ($n -gt 1) { $p += "$f is hard-linked ($n links)" }
    }
    $p
}

# Creates $Path already owned by $OwnerSid with a protected DACL (full control, (OI)(CI), for $GrantSids only), in one call,
# so there is no window with inherited ProgramData permissions.
function New-ProtectedDirectory([string]$Path, [Security.Principal.SecurityIdentifier]$OwnerSid, [Security.Principal.SecurityIdentifier[]]$GrantSids) {
    $sec = New-Object Security.AccessControl.DirectorySecurity
    $sec.SetOwner($OwnerSid)
    $sec.SetAccessRuleProtection($true, $false)
    foreach ($sid in $GrantSids) {
        $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    [void][IO.Directory]::CreateDirectory($Path, $sec)
}

$script:UntrustedDataDirMessage = "exists but wasn't created by the Skali installer (or has been tampered with). If it holds no Skali data you need, delete it from an elevated shell (Remove-Item -Recurse -Force <dir>) and re-run."

# Must run before the service first starts. Creates the dir when missing, accepts an existing one only if it is
# already trusted (an update leaves it alone), and otherwise throws. -DryRun reports which path would be taken
# and never throws or changes anything. -OwnerSid/-GrantSids/-StopAt exist for tests; the defaults are the real policy.
function Initialize-DataDirectory([string]$Dir, [switch]$DryRun,
        [Security.Principal.SecurityIdentifier]$OwnerSid = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'),
        [Security.Principal.SecurityIdentifier[]]$GrantSids = @((New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544')),
        [string]$StopAt = (Split-Path $Dir -Parent)) {
    if (-not (Test-Path -LiteralPath $Dir)) {
        if ($DryRun) { Write-Host "[dry-run] $Dir does not exist: would create it with its final protected ACL (owner Administrators, SYSTEM + Administrators full control, no inheritance), then assert it"; return }
        Write-Host "Creating $Dir with its final protected ACL"
        New-ProtectedDirectory $Dir $OwnerSid $GrantSids
        $problems = @(Get-DataDirProblems $Dir $StopAt)
        if ($problems) { throw "Newly created $Dir is not as expected: $($problems -join '; ')" }
        return
    }
    $problems = @()
    try { $problems = @(Get-DataDirProblems $Dir $StopAt) }
    catch { $problems = @("cannot inspect it: $($_.Exception.Message)") }
    if ($problems) {
        $msg = "$Dir $($script:UntrustedDataDirMessage -replace '<dir>', $Dir)`n  Problems: $(($problems | Select-Object -First 10) -join '; ')"
        if ($DryRun) { Write-Host "[dry-run] would fail: untrusted. $msg"; return }
        throw $msg
    }
    if ($DryRun) { Write-Host "[dry-run] $Dir exists and is trusted (admin-owned, protected, no links, no hard links): would leave it alone (update)" }
    else { Write-Host "$Dir exists and is trusted; leaving it as is." }
}

# Throws unless the data dir grants only SYSTEM + Administrators (allowlist, no Deny ACEs, protected, not a link) and
# the key, database and its WAL/SHM files inherit that. Runs before the service starts and again after.
function Assert-DataDirAcl([string]$Dir) {
    $problems = @()
    if (Test-IsReparsePoint $Dir) { $problems += 'the data dir is a junction/symlink' }
    $rules = @(Get-AclSids $Dir)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        if (-not ($rules | Where-Object { $_.Sid -eq $sid -and $_.Type -eq 'Allow' -and $_.Rights -match 'FullControl' })) { $problems += "$sid lacks full control on the data dir" }
    }
    $v = @(Get-AclViolations $Dir)
    if ($v) { $problems += "the data dir has: $($v -join ', ')" }
    try { Assert-OwnerTrusted $Dir } catch { $problems += $_.Exception.Message }
    if ((Get-Acl -LiteralPath $Dir).AreAccessRulesProtected -ne $true) { $problems += 'data dir still inherits permissions from its parent' }
    foreach ($name in 'secret.key', 'skali.db', 'skali.db-wal', 'skali.db-shm') {
        $file = Join-Path $Dir $name
        if (-not (Test-Path -LiteralPath $file)) { continue }
        try { Assert-OwnerTrusted $file } catch { $problems += $_.Exception.Message }
        $fv = @(Get-AclViolations $file)
        if ($fv) { $problems += "$name has: $($fv -join ', ')" }
        if (@(Get-AclSids $file | Where-Object { -not $_.Inherited })) { $problems += "$name has explicit (non-inherited) ACEs" }
    }
    if ($problems) { throw "Data dir ACL is wrong: $($problems -join '; ')" }
    Write-Host 'Data dir ACL verified: only SYSTEM and Administrators, inheritance disabled.'
}
