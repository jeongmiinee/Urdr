param(
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$outputRootFull = [IO.Path]::GetFullPath($OutputRoot)
$destination = Join-Path $outputRootFull 'URDR-Engine-v4.4-GitHub-Source'
$destinationFull = [IO.Path]::GetFullPath($destination)

if (-not $destinationFull.StartsWith($outputRootFull + [IO.Path]::DirectorySeparatorChar)) {
  throw 'Source export destination must remain inside OutputRoot.'
}

if (Test-Path -LiteralPath $destinationFull) {
  Remove-Item -LiteralPath $destinationFull -Recurse -Force
}
New-Item -ItemType Directory -Path $destinationFull -Force | Out-Null

function Copy-File([string]$RelativePath) {
  $source = Join-Path $repo $RelativePath
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    return
  }
  $target = Join-Path $destinationFull $RelativePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}

function Copy-Tree(
  [string]$RelativePath,
  [string[]]$ExcludedDirectoryNames = @(),
  [string[]]$ExcludedRelativePrefixes = @()
) {
  $sourceRoot = Join-Path $repo $RelativePath
  if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    return
  }
  foreach ($source in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
    $child = [IO.Path]::GetRelativePath($sourceRoot, $source.FullName)
    $segments = $child -split '[\\/]'
    if ($segments | Where-Object { $ExcludedDirectoryNames -contains $_ }) {
      continue
    }
    $normalized = $child.Replace('\', '/')
    $excluded = $false
    foreach ($prefix in $ExcludedRelativePrefixes) {
      if ($normalized.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        $excluded = $true
        break
      }
    }
    if ($excluded) {
      continue
    }
    $target = Join-Path (Join-Path $destinationFull $RelativePath) $child
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source.FullName -Destination $target -Force
  }
}

$rootFiles = @(
  '.gitattributes',
  '.gitignore',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'BUILD_INFO_ENGINE_4.4.txt',
  'CHANGELOG_ENGINE_4.4.md',
  'README_ENGINE_4.4.md',
  'TEST_REPORT_ENGINE_4.4.md',
  'THIRD_PARTY_NOTICES_ENGINE_4.4.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'vite.config.ts'
)
foreach ($file in $rootFiles) {
  Copy-File $file
}

Copy-Tree '.github'
Copy-Tree 'docs'
Copy-Tree 'native/urdr-wgpu' @('target', '.vscode')
Copy-Tree 'public'
Copy-Tree 'runtime-resources' @('__pycache__') @(
  'Data/Speech/IMS-Toucan/python/',
  'Data/Speech/IMS-Toucan/Models/'
)

# Electron 2.5 remains a compact UI and migration reference.
Copy-Tree 'src'
Copy-Tree 'desktop'
Copy-Tree 'vendor' @('node_modules', 'target')

Copy-File 'scripts/package-engine-4.4.ps1'
Copy-File 'scripts/package-engine-3.2.ps1'
Copy-File 'scripts/export-github-source.ps1'

$manifest = @"
URDR Engine 4.4 GitHub Source Export
Generated (UTC): $([DateTime]::UtcNow.ToString('o'))

Included:
- active Rust/WGPU source and Cargo lockfile
- development demos and non-speech runtime resources
- Electron 2.5 UI/migration reference source
- architecture, pipeline, persistence, diagnostics, contribution, and AI docs
- GitHub workflows/templates and active packaging scripts

Intentionally omitted:
- Rust target directories and all generated outputs
- portable executables/archives, logs, caches, and local saves
- IMS-Toucan embedded Python runtime and model weights
- Unity experiments and historical build artifact directories

Install the optional speech package separately before portable-package validation.
"@
Set-Content -LiteralPath (Join-Path $destinationFull 'SOURCE_EXPORT_MANIFEST.txt') -Value $manifest -Encoding utf8

$oversized = Get-ChildItem -LiteralPath $destinationFull -Recurse -File |
  Where-Object Length -GT 95MB |
  Sort-Object Length -Descending
if ($oversized) {
  $names = $oversized | ForEach-Object {
    '{0} ({1:N1} MiB)' -f [IO.Path]::GetRelativePath($destinationFull, $_.FullName), ($_.Length / 1MB)
  }
  throw "GitHub source export contains files over 95 MiB:`n$($names -join "`n")"
}

$files = Get-ChildItem -LiteralPath $destinationFull -Recurse -File
$bytes = ($files | Measure-Object Length -Sum).Sum
Write-Output ([PSCustomObject]@{
  Path = $destinationFull
  Files = $files.Count
  MiB = [math]::Round($bytes / 1MB, 1)
})
