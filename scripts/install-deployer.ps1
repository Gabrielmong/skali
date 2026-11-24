<#
.SYNOPSIS
  Sets up Skali's deploy helper (NSSM service "SkaliDeployer", LocalSystem, 127.0.0.1:4201) under -Root and moves Skali
  from the -From clone onto the release layout (<Root>\current). Run as Administrator. Use -DryRun to preview: it prints
  every step, changes nothing, never prompts, needs no elevation, and reports missing prerequisites as "would fail".
.DESCRIPTION
  First run: creates -Root locked (owner Administrators; SYSTEM + Administrators full control only, no inheritance),
  asks once for the GitHub token (hidden), generates the API token, clones the repo into <Root>\repo, builds the helper
  into <Root>\deployer\app, bootstraps (builds the -From clone's HEAD as releases\<sha7> and switches Skali onto it with
  a database backup and a health check; on failure Skali is put back on -From), then installs and starts SkaliDeployer.
  Re-run: updates the helper only (stop SkaliDeployer, fetch, rebuild deployer\app from origin/main, rewrite
  deployer.json, start). It never touches `current` once it exists.
.PARAMETER Root
  The deploy root (no spaces). Must be missing, or a root this script created earlier.
.PARAMETER From
  The existing install made by install-service.ps1. Its HEAD must be pushed to GitHub's main.
.PARAMETER NewToken
  Ask for the GitHub token again (for example after it expired) instead of keeping the stored one.
.EXAMPLE
  .\scripts\install-deployer.ps1 -DryRun
  .\scripts\install-deployer.ps1                       # -Root C:\SkaliDeploy -From C:\skali
  .\scripts\install-deployer.ps1 -NewToken             # replace an expired token, update the helper
#>
param(
    [string]$Root = 'C:\SkaliDeploy',
    [string]$From = 'C:\skali',
    [switch]$NewToken,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot\lib\common.ps1"
. "$PSScriptRoot\lib\acl.ps1"
. "$PSScriptRoot\lib\service.ps1"
. "$PSScriptRoot\lib\deployer-paths.ps1"
. "$PSScriptRoot\lib\deployer-layout.ps1"
. "$PSScriptRoot\lib\deployer-bins.ps1"
. "$PSScriptRoot\lib\deployer-secrets.ps1"
. "$PSScriptRoot\lib\deployer-git.ps1"
. "$PSScriptRoot\lib\deployer-app.ps1"

$service = 'SkaliDeployer'
$skaliService = 'Skali'
$dataDir = 'C:\ProgramData\Skali'
$gamesUser = 'SkaliGames'

if ($DryRun) { Write-Host "[dry-run] Skali deploy helper setup: nothing below is executed or changed." }

# Reports a failed prerequisite: throws in a real run, prints "would fail" in a dry run and continues.
function Report-Problem([string]$Message) {
    if ($DryRun) { Write-Host "[dry-run] would fail: $Message" } else { throw $Message }
}

Write-Host '== 1. Prerequisites'
Assert-Admin -DryRun:$DryRun

if ($Root -notmatch '^[A-Za-z]:\\[^\s]+$') { throw "-Root must be an absolute folder path without spaces (NSSM stores paths unquoted): '$Root'" }
$Root = Get-FullPath $Root
if ($From -notmatch '^[A-Za-z]:\\[^\s]+$') { throw "-From must be an absolute folder path without spaces: '$From'" }
$From = Get-FullPath $From
$profileRoots = @($env:USERPROFILE, $env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial, (Join-Path $env:SystemDrive 'Users')) | Where-Object { $_ }
if ($profileRoots | Where-Object { Test-PathInside $Root $_.TrimEnd('\') }) {
    throw "-Root ($Root) is under a user profile or OneDrive; LocalSystem runs code from it. Use a plain local folder such as C:\SkaliDeploy."
}
if ((Test-PathInside $Root $From) -or (Test-PathInside $From $Root) -or (Test-PathInside $Root $dataDir) -or (Test-PathInside $dataDir $Root)) {
    throw "-Root ($Root) must not overlap -From ($From) or the data dir ($dataDir)."
}
$layout = Get-DeployerLayout $Root

$run1st = 'run install-service.ps1 first (setup moves an existing install; it does not make one)'
if (-not (Get-Service $skaliService -ErrorAction SilentlyContinue)) { Report-Problem "The $skaliService service does not exist: $run1st." }
else { Write-Host "  service ${skaliService}: found" }
try { Assert-DataDirAcl $dataDir } catch { Report-Problem "$($_.Exception.Message) ($run1st; it creates $dataDir trusted)." }
if (-not (Get-LocalUser -Name $gamesUser -ErrorAction SilentlyContinue)) { Report-Problem "The local user $gamesUser does not exist: $run1st." }
else { Write-Host "  user ${gamesUser}: found" }

$found = Get-DeployerBins
foreach ($p in $found.Problems) { Report-Problem $p }
$bins = $found.Bins
$hasGit = $bins.git -notlike '<*'

Write-Host '== 2. Deploy root'
$rootExisted = (Get-PathState $Root) -ne 'Missing'
$untrustedRoot = "exists but wasn't created by install-deployer.ps1 (or has been tampered with). Check what it holds, move it aside (or delete it from an elevated shell: cmd /c rmdir /s /q <dir>) and re-run."
Initialize-DataDirectory $Root -RootOnly -UntrustedMessage $untrustedRoot -DryRun:$DryRun
if ($rootExisted) {
    $layoutProblems = @(Get-DeployLayoutProblems $layout)
    if ($layoutProblems) {
        Report-Problem "$Root is not a locked Skali deploy root: $(($layoutProblems | Select-Object -First 10) -join '; '). If someone browsed it with File Explorer and clicked Continue, their account was granted access: move the root aside and re-run, or remove that account's entries yourself (icacls $Root /remove:g <account> /T /C) and re-run. Browse $Root from an elevated PowerShell instead."
    } else { Write-Host "$Root layout checked (no links, SYSTEM + Administrators only)" }
}
$hasCurrent = (Get-PathState $layout.Current) -ne 'Missing'
if ($hasCurrent) { Write-Host "$($layout.Current) exists: this run only updates the helper (Skali and current are left alone)." }

# The -From install's HEAD is what the bootstrap builds; only needed when there is no `current` yet.
$fromSha = $null
if (-not $hasCurrent) {
    if (-not (Test-Path -LiteralPath (Join-Path $From 'scripts\install-service.ps1'))) {
        Report-Problem "-From $From is not a Skali install (no scripts\install-service.ps1)."
    } elseif ($hasGit) {
        try {
            $fromSha = Get-GitSha $bins.git $From 'HEAD' "the HEAD of $From"
            Write-Host "  -From HEAD: $fromSha"
            $dirty = (Invoke-Native $bins.git @('-C', $From, 'status', '--porcelain', '--untracked-files=no')).Output | Where-Object { $_ }
            if ($dirty) { Write-Warning "$From has uncommitted changes; they are not part of the release setup builds (it builds $fromSha from GitHub)." }
        } catch { Report-Problem "$($_.Exception.Message) Run this script from an elevated PowerShell (the repo is locked to Administrators)." }
    }
}

Write-Host "== 3. Stop $service if it is running (setup replaces its code)"
# Up to 11 min: the helper finishes a running deploy before it exits (AppStopMethodConsole 660 s).
$helperSvc = Get-Service $service -ErrorAction SilentlyContinue
$helperWasRunning = [bool]($helperSvc -and $helperSvc.Status -ne 'Stopped')
Stop-ServiceIfRunning $service -TimeoutSeconds 700 -DryRun:$DryRun

$script:DeployerAppReplaced = $false
$corepackEnv = Get-CorepackEnv $layout
try {
    Write-Host '== 4. Layout folders'
    New-LayoutFolders $layout -DryRun:$DryRun

    Write-Host '== 5. Tokens'
    Initialize-GitHubToken $Root $layout.GitHubToken -NewToken:$NewToken -DryRun:$DryRun
    Initialize-ApiToken $Root $layout.ApiToken -DryRun:$DryRun

    Write-Host '== 6. Repo clone'
    Sync-DeployerRepo $bins.git $Root $layout.Repo $layout.GitHubToken -DryRun:$DryRun
    if ($DryRun) {
        Write-Host '[dry-run] would read origin/main and its apps/deployer tree (installedDeployerTree, same as the helper: rev-parse <origin/main>:apps/deployer)'
        if (-not $hasCurrent) {
            $shown = if ($fromSha) { $fromSha } else { '<sha>' }
            Write-Host "[dry-run] would check that the -From HEAD $shown is on origin/main (else: push it first)"
            Write-Host "[dry-run] would check that $shown's scripts/apply-service-settings.ps1 has -AppDirectory (else: push and pull this version first)"
        }
        $mainSha = '<origin/main sha>'
        $tree = '<tree-hash>'
    } else {
        $mainSha = Get-GitSha $bins.git $layout.Repo 'refs/remotes/origin/main' 'origin/main' -DeployRepo
        $tree = Get-DeployerTree $bins.git $layout.Repo $mainSha
        Write-Host "  origin/main $mainSha, apps/deployer tree $tree"
        if (-not $hasCurrent) {
            $notOnMain = Get-ShaOnOriginProblem $bins.git $layout.Repo $fromSha $From
            if ($notOnMain) { throw $notOnMain }
            $oldScript = Get-BootstrapScriptProblem $bins.git $layout.Repo $fromSha $From
            if ($oldScript) { throw $oldScript }
        }
    }

    # Every pnpm run from here (the helper's build and the bootstrap's release build) uses the helper's corepack cache,
    # so the pnpm that corepack downloads is already there when the helper first runs pnpm as LocalSystem.
    if ($DryRun) { Write-Host "[dry-run] would set COREPACK_HOME=$($layout.Corepack) and COREPACK_ENABLE_DOWNLOAD_PROMPT=0 for steps 7-8 (restored afterwards)" }
    Use-ProcessEnv $(if ($DryRun) { @{} } else { $corepackEnv }) {
        Write-Host '== 7. Build the helper into deployer\app and write deployer.json'
        Install-DeployerApp $layout $bins $mainSha -DryRun:$DryRun
        Write-DeployerConfig $layout $bins $tree -DryRun:$DryRun

        Write-Host '== 8. Bootstrap (first run only)'
        if ($hasCurrent) { Write-Host 'Skipped: current exists (re-running setup never touches current or Skali).' }
        else { Invoke-DeployerBootstrap $layout $bins.node $(if ($fromSha) { $fromSha } else { '<from-head-sha>' }) $From -DryRun:$DryRun }
    }
} catch {
    Write-Warning "Setup failed: $($_.Exception.Message)"
    if (-not $DryRun) {
        # An interrupted or crashed bootstrap must not leave Skali stopped: with no `current` yet, Skali's settings still
        # point at -From (the bootstrap only changes them after switching current), so starting it runs -From as before.
        $skaliSvc = Get-Service $skaliService -ErrorAction SilentlyContinue
        if (-not $hasCurrent -and (Get-PathState $layout.Current) -eq 'Missing' -and $skaliSvc -and $skaliSvc.Status -eq 'Stopped') {
            Write-Warning "$skaliService is stopped and $($layout.Current) was never created: starting $skaliService again from $From (its settings are unchanged)."
            try { Start-ServiceAndWait $skaliService 30 } catch { Write-Warning "Could not start ${skaliService}: $($_.Exception.Message). Run $From\scripts\install-service.ps1 from an elevated PowerShell." }
        }
        # The helper update failed before the old deployer\app was replaced: the old helper is intact, so run it again.
        if ($helperWasRunning -and -not $script:DeployerAppReplaced -and (Get-Service $service -ErrorAction SilentlyContinue)) {
            Write-Warning "The old $service code was not replaced: starting it again."
            try { Start-ServiceAndWait $service 30 } catch { Write-Warning "Could not start ${service}: $($_.Exception.Message)" }
        } elseif (Get-Service $service -ErrorAction SilentlyContinue) {
            Write-Warning "$service is stopped$(if ($script:DeployerAppReplaced) { ' (its code was already replaced)' }). Fix the problem above and re-run this script."
        }
    }
    throw
}

Write-Host "== 9. Service $service"
Install-DeployerService $service $layout $bins.node -DryRun:$DryRun
Start-ServiceAndWait $service 30 -DryRun:$DryRun

Write-Host '== 10. Final checks'
if ($DryRun) {
    Write-Host "[dry-run] would re-check $Root (root ACL, layout) and the data dir ACL"
} else {
    $problems = @(Get-DataDirProblems $Root -RootOnly) + @(Get-DeployLayoutProblems $layout)
    if ($problems) { throw "$Root is not as expected after setup: $($problems -join '; ')" }
    Assert-DataDirAcl $dataDir
    Get-Service $skaliService, $service
    Write-Host "Done. Skali runs from $($layout.Current); the helper polls GitHub every 2 minutes. Deploys page: http://192.168.0.100:$SkaliPort/deploys. Helper log: $($layout.ServiceOut); deploy logs: $($layout.EventLogs). $From stays as the manual fallback (install-service.ps1)."
}
