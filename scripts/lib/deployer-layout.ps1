# The deploy root's folder layout (mirrors pathsFor in apps/deployer/src/config.ts) and its checks.
# Everything under the root inherits the root's locked DACL (SYSTEM + Administrators only); nothing gets an ACL of its own.
# Dot-source after common.ps1, acl.ps1 and deployer-paths.ps1; do not run.

function Get-DeployerLayout([string]$Root) {
    $data = Join-Path $Root 'deployer'
    [ordered]@{
        Root = $Root; Repo = Join-Path $Root 'repo'; Releases = Join-Path $Root 'releases'; Current = Join-Path $Root 'current'
        Data = $data; EventLogs = Join-Path $data 'logs'; Backups = Join-Path $data 'backups'; PnpmStore = Join-Path $data 'pnpm-store'
        Corepack = Join-Path $data 'corepack'
        App = Join-Path $data 'app'; Build = Join-Path $data 'app-build'; Config = Join-Path $data 'deployer.json'
        History = Join-Path $data 'history.json'; GitHubToken = Join-Path $data 'github-token'; ApiToken = Join-Path $data 'api-token'
        ServiceOut = Join-Path $data 'service.out.log'
    }
}

# Folders setup creates under the root, parents first.
function Get-LayoutFolders($Layout) { @($Layout.Data, $Layout.EventLogs, $Layout.Backups, $Layout.Corepack, $Layout.Releases, $Layout.Repo) }

# corepack's cache (the pnpm it downloads), shared by setup and the helper so setup's first pnpm run pre-warms it for
# LocalSystem (which has no usable profile cache). Both get these, plus no download prompt nobody could answer.
function Get-CorepackEnv($Layout) { [ordered]@{ COREPACK_HOME = $Layout.Corepack; COREPACK_ENABLE_DOWNLOAD_PROMPT = '0' } }

# Every fixed path setup creates, writes or deletes (except `current`, which has its own rule): none may be a link.
function Get-LayoutFixedPaths($Layout) {
    @(Get-LayoutFolders $Layout) + @($Layout.PnpmStore, $Layout.App, $Layout.Build, $Layout.Config, $Layout.History,
        $Layout.GitHubToken, $Layout.ApiToken, $Layout.ServiceOut)
}

# For an existing root (whose own ACL Initialize-DataDirectory -RootOnly already accepted): every fixed path and every
# release folder is a real file/folder (not a link), owned by Administrators/SYSTEM, with no ACE (explicit or inherited)
# for anyone but SYSTEM/Administrators, and `current` is missing or a junction to a release. Read-only. Returns problems.
function Get-DeployLayoutProblems($Layout) {
    $problems = @()
    $sample = @()
    foreach ($p in Get-LayoutFixedPaths $Layout) {
        $state = Get-PathState $p
        if ($state -eq 'Missing') { continue }
        if ($state -eq 'Link') { $problems += "$p is a link (reparse point)"; continue }
        $sample += $p
    }
    try { Assert-CurrentLink $Layout.Current $Layout.Releases } catch { $problems += $_.Exception.Message }
    if ((Get-PathState $Layout.Releases) -eq 'Dir') {
        foreach ($rel in Get-ChildItem -LiteralPath $Layout.Releases -Force) {
            if ($rel.Attributes -band [IO.FileAttributes]::ReparsePoint) { $problems += "$($rel.FullName) is a link (reparse point)"; continue }
            $sample += $rel.FullName
        }
    }
    foreach ($s in $sample) {
        try { Assert-OwnerTrusted $s } catch { $problems += $_.Exception.Message }
        try { $v = @(Get-AclViolations $s) } catch { $problems += "$s (ACL unreadable: $($_.Exception.Message))"; continue }
        if ($v) { $problems += "$s has $($v -join ', ')" }
    }
    $problems
}

# Creates the missing layout folders under the locked root; they inherit its DACL. Existing ones were checked above.
function New-LayoutFolders($Layout, [switch]$DryRun) {
    foreach ($f in Get-LayoutFolders $Layout) {
        if (-not $DryRun) { Assert-NoLinkChain $Layout.Root $f }
        if ((Get-PathState $f) -ne 'Missing') { continue }
        Invoke-Step "Create $f (inherits the root's SYSTEM + Administrators ACL)" { New-Item -ItemType Directory -Path $f | Out-Null } -DryRun:$DryRun
    }
}
