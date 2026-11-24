# Path checks for the deploy layout: links are never followed, created through or removed; they are refused.
# Ported from Home (scripts/lib/deployer-paths.ps1). Dot-source after common.ps1; do not run.

function Get-FullPath([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }

# 'Missing', 'Link' (any reparse point, also a dangling one), 'Dir' or 'File'. Looks at the path itself, never a target.
function Get-PathState([string]$Path) {
    try { $attr = [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return 'Missing' }
    if ($attr -band [IO.FileAttributes]::ReparsePoint) { 'Link' }
    elseif ($attr -band [IO.FileAttributes]::Directory) { 'Dir' }
    else { 'File' }
}

function Test-IsLink([string]$Path) { (Get-PathState $Path) -eq 'Link' }

# Throws when a fixed layout path is a reparse point (checked before it is created, written or deleted).
function Assert-NotLink([string]$Path) {
    if ((Get-PathState $Path) -eq 'Link') { throw "$Path is a link (reparse point); refusing to use it. Remove it yourself after checking where it points." }
}

# Throws when <Root> or any path component between it and $Path (inclusive) is a link, so a junction planted at a
# parent cannot redirect the write either.
function Assert-NoLinkChain([string]$Root, [string]$Path) {
    $rootFull = Get-FullPath $Root
    $full = Get-FullPath $Path
    $inside = [string]::Equals($full, $rootFull, [StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
    if (-not $inside) { throw "$Path is not inside $Root" }
    $cur = $rootFull
    Assert-NotLink $cur
    foreach ($part in $full.Substring($rootFull.Length).Split([char[]]'\', [StringSplitOptions]::RemoveEmptyEntries)) {
        $cur = Join-Path $cur $part
        Assert-NotLink $cur
    }
}

# Where a link points, as a full path: a relative target is resolved against the link's parent.
function Resolve-LinkTarget([string]$Link) {
    $target = @((Get-Item -LiteralPath $Link -Force).Target)[0]
    if (-not $target) { return $null }
    $target = $target -replace '^\\\\\?\\', '' -replace '^\\\?\?\\', ''
    Get-FullPath ([IO.Path]::Combine((Split-Path $Link -Parent), $target))
}

# `current` may be missing, or a junction to an existing real directory releases\<x>; anything else throws.
function Assert-CurrentLink([string]$Current, [string]$Releases) {
    $state = Get-PathState $Current
    if ($state -eq 'Missing') { return }
    $item = Get-Item -LiteralPath $Current -Force
    if ($state -ne 'Link' -or $item.LinkType -ne 'Junction') { throw "$Current must be a junction to a release (it is a $(if ($item.LinkType) { $item.LinkType } else { $state }))" }
    $target = Resolve-LinkTarget $Current
    $parent = if ($target) { Split-Path $target -Parent } else { $null }
    $inReleases = $parent -and [string]::Equals($parent, (Get-FullPath $Releases), [StringComparison]::OrdinalIgnoreCase)
    if (-not $inReleases -or (Get-PathState $target) -ne 'Dir') { throw "$Current points at '$target', not an existing folder directly in $Releases" }
}

# Deletes a folder the layout owns with cmd's rmdir /s /q, which removes junctions inside it WITHOUT following them
# (PowerShell 5.1's Remove-Item -Recurse can follow them). The folder itself and its parents up to <Root> must not be links.
function Remove-LayoutFolder([string]$Root, [string]$Path) {
    Assert-NoLinkChain $Root $Path
    if ((Get-PathState $Path) -eq 'Missing') { return }
    if ((Get-PathState $Path) -ne 'Dir') { throw "$Path is not a directory; refusing to delete it." }
    & cmd.exe /c rmdir /s /q "`"$Path`""
    if ((Get-PathState $Path) -ne 'Missing') { throw "Could not delete $Path" }
}
