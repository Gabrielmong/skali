# Clone/fetch of the repo into <Root>\repo and the commit checks setup needs. The GitHub token reaches git only through
# the environment of that one git process (GIT_CONFIG_* carrying http.https://github.com/.extraheader): never argv, the
# remote URL, git config, or this PowerShell session's environment. Ported from Home (scripts/lib/deployer-git.ps1).
# Dot-source after common.ps1, deployer-bins.ps1 (Invoke-Native, Use-ProcessEnv), deployer-paths.ps1 and deployer-secrets.ps1 (Read-SecretText); do not run.

$script:SkaliRepoUrl = 'https://github.com/Gabrielmong/skali.git'

# One Windows command-line argument (ProcessStartInfo.Arguments; .NET Framework has no ArgumentList).
function ConvertTo-WindowsArgument([string]$Arg) {
    if ($Arg -match '"') { throw "Refusing an argument that contains a double quote: $Arg" }
    if ($Arg -ne '' -and $Arg -notmatch '\s') { return $Arg }
    '"' + ($Arg -replace '(\\+)$', '$1$1') + '"'
}

# Child-only git config for every git call on <Root>\repo, the same shape as the helper's gitLocalEnv
# (apps/deployer/src/real-context.ts): safe.directory for the repo (forward slashes; git refuses a repo owned by
# Administrators as "dubious ownership" for SYSTEM and may for an admin) and no credential prompts. Not secret.
function Get-RepoGitEnv([string]$Repo) {
    [ordered]@{
        GIT_CONFIG_COUNT = '2'
        GIT_CONFIG_KEY_0 = 'safe.directory'; GIT_CONFIG_VALUE_0 = ($Repo -replace '\\', '/')
        GIT_CONFIG_KEY_1 = 'credential.interactive'; GIT_CONFIG_VALUE_1 = 'false'
        GCM_INTERACTIVE = 'never'; GIT_TERMINAL_PROMPT = '0'
    }
}

# git -C $Repo <args> with Get-RepoGitEnv set for that call only. Returns Invoke-Native's result.
function Invoke-RepoGit([string]$Git, [string]$Repo, [string[]]$Arguments) {
    Use-ProcessEnv (Get-RepoGitEnv $Repo) { Invoke-Native $Git (@('-C', $Repo) + $Arguments) }
}

# Runs git with the token in the CHILD's environment only (a copy of this process's environment plus GIT_CONFIG_*), so
# nothing in this session, argv or on disk ever holds it. Output goes straight to the console. Sets $LASTEXITCODE.
function Invoke-GitWithToken([string]$Git, [string]$Repo, [string[]]$Arguments, [string]$TokenFile) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Git
    $psi.Arguments = (@($Arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('x-access-token:' + (Read-SecretText $TokenFile)))
    $envs = $psi.EnvironmentVariables
    # safe.directory and no prompts (a rejected token fails at once instead of opening Git Credential Manager's browser
    # login), then the token: the same shape as the helper's gitEnv.
    $local = Get-RepoGitEnv $Repo
    foreach ($k in $local.Keys) { $envs[$k] = $local[$k] }
    $envs['GIT_CONFIG_COUNT'] = '3'
    $envs['GIT_CONFIG_KEY_2'] = 'http.https://github.com/.extraheader'   # sent to github.com only, never to a redirect target
    $envs['GIT_CONFIG_VALUE_2'] = "Authorization: Basic $basic"
    $p = [Diagnostics.Process]::Start($psi)
    try { $p.WaitForExit(); $code = $p.ExitCode } finally { $p.Dispose(); $basic = $null; $psi = $null }
    $global:LASTEXITCODE = $code
    if ($code -ne 0) {
        Write-Warning "GitHub refused the token or the repo (git exit code $code). Check the token with: curl.exe -s -o NUL -w '%{http_code}' -H ""Authorization: Bearer <token>"" https://api.github.com/repos/Gabrielmong/skali (200 = ok, 401 = bad or expired token, 404 = the token can't see this repo). To enter a new one, re-run with -NewToken."
    }
}

# Clones the repo into <Root>\repo (created empty by New-LayoutFolders), or fetches origin when it is already a clone.
# An existing clone must have origin = the Skali repo.
function Sync-DeployerRepo([string]$Git, [string]$Root, [string]$Repo, [string]$TokenFile, [switch]$DryRun) {
    $url = $script:SkaliRepoUrl
    if (-not $DryRun) { Assert-NoLinkChain $Root $Repo }
    if (Test-Path -LiteralPath (Join-Path $Repo '.git')) {
        $origin = (Invoke-RepoGit $Git $Repo @('remote', 'get-url', 'origin')).Output | Select-Object -First 1
        if ("$origin".Trim() -ne $url) { throw "$Repo has origin '$origin', not $url. Move it aside and re-run." }
        Invoke-Step "git fetch origin in $Repo (token only in that git process's environment)" {
            Invoke-GitWithToken $Git $Repo @('-C', $Repo, 'fetch', '--quiet', '--prune', 'origin') $TokenFile
        } -DryRun:$DryRun
    } else {
        if (-not $DryRun -and @(Get-ChildItem -LiteralPath $Repo -Force -ErrorAction SilentlyContinue).Count -gt 0) {
            throw "$Repo is not a git clone and not empty. Move it aside and re-run."
        }
        Invoke-Step "git clone $url into $Repo (token only in that git process's environment, not stored)" {
            Invoke-GitWithToken $Git $Repo @('clone', '--quiet', $url, $Repo) $TokenFile
        } -DryRun:$DryRun
    }
}

# Full lowercase sha of a rev in $Repo, or throws. -DeployRepo: $Repo is <Root>\repo (safe.directory env); the -From
# clone is read as-is.
function Get-GitSha([string]$Git, [string]$Repo, [string]$Rev, [string]$What, [switch]$DeployRepo) {
    $a = @('rev-parse', '--verify', "$Rev^{commit}")
    $r = if ($DeployRepo) { Invoke-RepoGit $Git $Repo $a } else { Invoke-Native $Git (@('-C', $Repo) + $a) }
    $sha = "$($r.Output | Select-Object -Last 1)".Trim()
    if ($r.ExitCode -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw "Could not read $What ($Rev in $Repo)." }
    $sha
}

# The apps/deployer tree of a commit: the deployer compares it with refs/remotes/origin/main:apps/deployer to show
# "helper update available" (deployer.ts fetchedDeployerTree), so it must be computed the same way.
function Get-DeployerTree([string]$Git, [string]$Repo, [string]$Sha) {
    $r = Invoke-RepoGit $Git $Repo @('rev-parse', "${Sha}:apps/deployer")
    $tree = "$($r.Output | Select-Object -Last 1)".Trim()
    if ($r.ExitCode -ne 0 -or $tree -notmatch '^[0-9a-f]{40}$') { throw "Could not read ${Sha}:apps/deployer. Is the deployer pushed to main?" }
    $tree
}

# $null when $Sha is on origin/main in $Repo (fetched); otherwise what the owner has to do.
function Get-ShaOnOriginProblem([string]$Git, [string]$Repo, [string]$Sha, [string]$From) {
    $push = "Commit and push $From to GitHub's main first (setup builds the -From install's HEAD from GitHub), then re-run."
    if ((Invoke-RepoGit $Git $Repo @('cat-file', '-e', "$Sha^{commit}")).ExitCode -ne 0) {
        return "The -From HEAD $Sha is not on GitHub. $push"
    }
    $r = Invoke-RepoGit $Git $Repo @('merge-base', '--is-ancestor', $Sha, 'refs/remotes/origin/main')
    if ($r.ExitCode -eq 0) { return $null }
    if ($r.ExitCode -eq 1) { return "The -From HEAD $Sha is on GitHub but not on main. $push" }
    "Could not check whether $Sha is on origin/main (git exit code $($r.ExitCode))."
}

# $null when the -From HEAD's own scripts/apply-service-settings.ps1 has the -AppDirectory parameter: the bootstrap runs
# that script (from the new release) to put Skali back on -From after a failed health check. Read from <Root>\repo.
function Get-BootstrapScriptProblem([string]$Git, [string]$Repo, [string]$Sha, [string]$From) {
    $pull = "Push and pull this version first: $From's HEAD ($Sha) has no scripts/apply-service-settings.ps1 with the -AppDirectory parameter, which the bootstrap needs to put Skali back on $From if the new release fails. Commit and push the current Skali (with auto-deploy) to main, git pull in $From, and re-run."
    $r = Invoke-RepoGit $Git $Repo @('show', "${Sha}:scripts/apply-service-settings.ps1")
    if ($r.ExitCode -ne 0) { return $pull }
    if (-not (($r.Output -join "`n") -match '\[string\]\s*\$AppDirectory\b')) { return $pull }
    $null
}
