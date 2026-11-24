# deployer.json, the helper's own build into <Root>\deployer\app, the setup bootstrap and the SkaliDeployer NSSM
# service. Ported from Home (scripts/lib/deployer-app.ps1): built in place under the locked root (not %TEMP%), no
# `pnpm deploy` (the helper has no runtime dependencies), no LocalService. Dot-source after common.ps1, service.ps1,
# deployer-paths.ps1 and deployer-bins.ps1; do not run.

# The REQUIRED keys of apps/deployer/src/config.ts loadConfig; everything else keeps the helper's defaults
# (repo Gabrielmong/skali, port 4201, service Skali, app port 4200, data dir C:\ProgramData\Skali).
function Write-DeployerConfig($Layout, $Bins, [string]$Tree, [switch]$DryRun) {
    $config = [ordered]@{
        root = $Layout.Root
        tokenFile = $Layout.GitHubToken
        apiTokenFile = $Layout.ApiToken
        bin = $Bins
        installedDeployerTree = $Tree
    }
    $json = $config | ConvertTo-Json -Depth 4
    if ($DryRun) { Write-Host "[dry-run] would write $($Layout.Config):"; Write-Host $json; return }
    Assert-NoLinkChain $Layout.Root $Layout.Config
    [IO.File]::WriteAllText($Layout.Config, $json, (New-Object Text.UTF8Encoding $false))   # no BOM: JSON.parse rejects one
    Write-Host "Wrote $($Layout.Config)"
}

# Exports $Sha (origin/main) from the repo into deployer\app-build, installs and builds only @skali/deployer there, and
# replaces deployer\app with its dist\ and package.json ("type": "module"). Everything is written under the locked root,
# so it inherits SYSTEM + Administrators only. SkaliDeployer must be stopped. Sets $script:DeployerAppReplaced just
# before the old deployer\app is removed (until then a failure leaves the old helper intact). Run it inside
# Use-ProcessEnv (Get-CorepackEnv $Layout), so pnpm fills the corepack cache the helper uses.
function Install-DeployerApp($Layout, $Bins, [string]$Sha, [switch]$DryRun) {
    $build = $Layout.Build
    $src = Join-Path $build 'src'
    $tar = Join-Path $build 'src.tar'
    $deployerSrc = Join-Path $src 'apps\deployer'
    if (-not $DryRun) {
        Remove-LayoutFolder $Layout.Root $build
        New-Item -ItemType Directory -Path $src -Force | Out-Null
    } else { Write-Host "[dry-run] would recreate $build" }
    try {
        Invoke-Step "Export origin/main ($Sha) from $($Layout.Repo) to $src" {
            $r = Invoke-RepoGit $Bins.git $Layout.Repo @('archive', '--format=tar', '-o', $tar, $Sha)
            $global:LASTEXITCODE = $r.ExitCode
            if ($LASTEXITCODE -eq 0) { & $Bins.tar -xf $tar -C $src }
        } -DryRun:$DryRun
        # Run from the export: corepack picks the pnpm version from the package.json of the working directory.
        Invoke-Step "pnpm install --frozen-lockfile --filter @skali/deployer... (store $($Layout.PnpmStore))" {
            Push-Location $src
            try { & $Bins.pnpm install --frozen-lockfile --filter '@skali/deployer...' --store-dir $Layout.PnpmStore } finally { Pop-Location }
        } -DryRun:$DryRun
        Invoke-Step 'pnpm --filter @skali/deployer build' {
            Push-Location $src
            try { & $Bins.pnpm --filter '@skali/deployer' build } finally { Pop-Location }
        } -DryRun:$DryRun
        Invoke-Step "Replace $($Layout.App) with the new dist\ and package.json" {
            $main = Join-Path $deployerSrc 'dist\main.js'
            if (-not (Test-Path -LiteralPath $main)) { throw "Build output missing: $main" }
            $script:DeployerAppReplaced = $true   # from here on the old helper's code is gone
            Remove-LayoutFolder $Layout.Root $Layout.App
            New-Item -ItemType Directory -Path $Layout.App | Out-Null
            Copy-Item -LiteralPath (Join-Path $deployerSrc 'dist') -Destination (Join-Path $Layout.App 'dist') -Recurse
            Copy-Item -LiteralPath (Join-Path $deployerSrc 'package.json') -Destination (Join-Path $Layout.App 'package.json')
            $global:LASTEXITCODE = 0
        } -DryRun:$DryRun
    } finally {
        if (-not $DryRun) {
            try { Remove-LayoutFolder $Layout.Root $build } catch { Write-Warning "Could not remove ${build}: $($_.Exception.Message)" }
        }
    }
}

# node deployer\app\dist\main.js <config> --bootstrap <sha> --from <From>: builds the -From HEAD as releases\<sha7> and
# moves Skali onto it (apps/deployer/src/bootstrap.ts). On failure it has already put Skali back on -From; throws.
function Invoke-DeployerBootstrap($Layout, [string]$Node, [string]$Sha, [string]$From, [switch]$DryRun) {
    $main = Join-Path $Layout.App 'dist\main.js'
    $desc = "Bootstrap: $Node $main $($Layout.Config) --bootstrap $Sha --from $From (build releases\$(if ($Sha -match '^[0-9a-f]{7}') { $Sha.Substring(0, 7) } else { '<sha7>' }), stop Skali, back up the database, switch current, apply settings, start, health check)"
    if ($DryRun) { Write-Host "[dry-run] $desc"; return }
    Write-Host $desc
    $global:LASTEXITCODE = 0
    & $Node $main $Layout.Config --bootstrap $Sha --from $From
    if ($LASTEXITCODE -ne 0) {
        throw "The bootstrap failed (see the lines above and $($Layout.EventLogs)). Skali was put back on $From where possible; check Get-Service Skali. Fix the problem and re-run this script."
    }
}

# LocalSystem service: node <app>\dist\main.js <config>. The caller has checked the paths contain no spaces (NSSM stores
# AppParameters unquoted). No firewall rule: the helper listens on 127.0.0.1 only.
function Install-DeployerService([string]$Service, $Layout, [string]$Node, [switch]$DryRun) {
    $params = "$(Join-Path $Layout.App 'dist\main.js') $($Layout.Config)"
    if (Get-Service $Service -ErrorAction SilentlyContinue) {
        Set-NssmValue $Service 'Application' $Node -DryRun:$DryRun
        Set-NssmValue $Service 'AppParameters' $params -DryRun:$DryRun
    } else {
        Invoke-Step "nssm install $Service $Node $params" { nssm install $Service $Node $params | Out-Null } -DryRun:$DryRun
    }
    Set-NssmValue $Service 'AppDirectory' $Layout.App -DryRun:$DryRun
    Set-NssmValue $Service 'DisplayName' 'Skali deploy helper' -DryRun:$DryRun
    Set-NssmValue $Service 'ObjectName' 'LocalSystem' -DryRun:$DryRun
    # Delayed: Skali (automatic) comes up first on boot; the helper's recovery then only fixes what needs fixing.
    Set-NssmValue $Service 'Start' 'SERVICE_DELAYED_AUTO_START' -DryRun:$DryRun
    Set-NssmValues $Service 'AppExit' @('Default', 'Restart') -DryRun:$DryRun
    Set-NssmValue $Service 'AppRestartDelay' '5000' -DryRun:$DryRun
    Set-NssmValue $Service 'AppStdout' $Layout.ServiceOut -DryRun:$DryRun
    Set-NssmValue $Service 'AppStderr' $Layout.ServiceOut -DryRun:$DryRun
    Set-NssmValue $Service 'AppRotateFiles' '1' -DryRun:$DryRun
    Set-NssmValue $Service 'AppRotateOnline' '1' -DryRun:$DryRun
    Set-NssmValue $Service 'AppRotateBytes' '10485760' -DryRun:$DryRun
    # The helper finishes the running operation (up to 10 min) before it exits.
    Set-NssmValue $Service 'AppStopMethodConsole' '660000' -DryRun:$DryRun
    # pnpm runs as LocalSystem on every deploy: corepack uses the cache setup pre-warmed (deployer\corepack) and never
    # waits on a download prompt nobody can answer.
    $corepack = Get-CorepackEnv $Layout
    Set-NssmValues $Service 'AppEnvironmentExtra' @($corepack.Keys | ForEach-Object { "$_=$($corepack[$_])" }) -DryRun:$DryRun
}
