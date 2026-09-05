param(
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs'),
  [switch]$SkipLaunchTest,
  [switch]$ZipOnly,
  [switch]$KeepPortable,
  [switch]$OmitLauncher,
  [switch]$PortableOnly,
  [string]$ReleaseVersion = '3.2'
)

$ErrorActionPreference = 'Stop'
$version = $ReleaseVersion
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = [System.IO.Path]::GetFullPath($OutputRoot)

function Assert-OutputPath([string]$Path) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith($output + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe output path: $resolved"
  }
}

function Reset-Directory([string]$Path) {
  Assert-OutputPath $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Remove-PackagingDirectory([string]$Path) {
  Assert-OutputPath $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Remove-PackagingFile([string]$Path) {
  Assert-OutputPath $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Write-Zip([string]$Source, [string]$ZipPath) {
  Assert-OutputPath $ZipPath
  if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }
  $sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
  if ($sevenZip) {
    Push-Location $Source
    try {
      & $sevenZip.Source a -tzip -mx=0 -mmt=on $ZipPath '.\*' | Out-Null
    } finally {
      Pop-Location
    }
  } else {
    & tar.exe -a -c -f $ZipPath -C $Source .
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Archive creation failed: $ZipPath"
  }
  if ((Get-Item -LiteralPath $ZipPath).Length -le 0) {
    throw "Archive is empty: $ZipPath"
  }
}

function Copy-NativeSource([string]$Destination) {
  $source = Join-Path $repo 'native\urdr-wgpu'
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($name in @('Cargo.toml', 'Cargo.lock', 'src', 'examples', '.vscode')) {
    $item = Join-Path $source $name
    if (Test-Path -LiteralPath $item) {
      Copy-Item -LiteralPath $item -Destination $Destination -Recurse -Force
    }
  }
}

function Copy-ReleaseDocuments([string]$Destination) {
  foreach ($name in @(
    "README_ENGINE_$version.md",
    "CHANGELOG_ENGINE_$version.md",
    "BUILD_INFO_ENGINE_$version.txt",
    "TEST_REPORT_ENGINE_$version.md",
    "GITHUB_RELEASE_ENGINE_$version.md",
    "THIRD_PARTY_NOTICES_ENGINE_$version.md",
    'ENGINE_VERSION.txt'
  )) {
    $item = Join-Path $repo $name
    if (-not (Test-Path -LiteralPath $item)) {
      throw "Release document is missing: $name"
    }
    Copy-Item -LiteralPath $item -Destination $Destination -Force
  }
  $migrationDocument = Join-Path $repo "REGIONAL_REFINEMENT_MIGRATION_ENGINE_$version.md"
  if (Test-Path -LiteralPath $migrationDocument) {
    Copy-Item -LiteralPath $migrationDocument -Destination $Destination -Force
  }
}

function Copy-TreeWithoutPythonCache([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  & robocopy.exe $Source $Destination /E /R:1 /W:1 /XD __pycache__ /XF *.pyc /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "Resource copy failed: $Source -> $Destination (robocopy exit $LASTEXITCODE)"
  }
}

function Copy-RuntimeTree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  # Embedded inference needs DLL/PYD binaries and model weights, not C/C++
  # import/static libraries. Excluding them removes hundreds of megabytes of
  # development-only PyTorch files from every distribution.
  & robocopy.exe $Source $Destination /E /R:1 /W:1 /XD __pycache__ /XF *.pyc *.lib /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "Runtime resource copy failed: $Source -> $Destination (robocopy exit $LASTEXITCODE)"
  }
}

function Copy-RuntimeResources([string]$Destination) {
  foreach ($name in @('Data', 'Localization', 'Graphics', 'Templates', 'Licenses')) {
    $target = Join-Path $Destination $name
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $source = Join-Path $repo "runtime-resources\$name"
    if (Test-Path -LiteralPath $source) {
      Copy-RuntimeTree $source $target
    }
  }
  $demos = Join-Path $Destination 'Data\Demos'
  New-Item -ItemType Directory -Path $demos -Force | Out-Null
  foreach ($name in @(
    'demoNativeWorld.json.gz',
    'demoNativeWorld.en.json.gz',
    'demoProjectData.json.gz',
    'demoProjectData.en.json.gz'
  )) {
    Copy-Item -LiteralPath (Join-Path $repo "public\$name") -Destination $demos -Force
  }
  Copy-Item -LiteralPath (Join-Path $repo "THIRD_PARTY_NOTICES_ENGINE_$version.md") `
    -Destination (Join-Path $Destination 'Licenses\THIRD_PARTY_NOTICES.md') -Force
}

function Copy-SourcePackage([string]$Destination, [bool]$GitHub) {
  Reset-Directory $Destination
  Copy-NativeSource (Join-Path $Destination 'native\urdr-wgpu')
  Copy-RuntimeTree (Join-Path $repo 'runtime-resources') (Join-Path $Destination 'runtime-resources')
  if (Test-Path -LiteralPath (Join-Path $repo 'research-data')) {
    Copy-TreeWithoutPythonCache (Join-Path $repo 'research-data') (Join-Path $Destination 'research-data')
  }

  $public = Join-Path $Destination 'public'
  New-Item -ItemType Directory -Path $public -Force | Out-Null
  foreach ($name in @(
    'demoNativeWorld.json.gz',
    'demoNativeWorld.en.json.gz',
    'demoProjectData.json.gz',
    'demoProjectData.en.json.gz'
  )) {
    Copy-Item -LiteralPath (Join-Path $repo "public\$name") -Destination $public -Force
  }

  Copy-ReleaseDocuments $Destination
  Copy-Item -LiteralPath (Join-Path $repo "README_ENGINE_$version.md") -Destination (Join-Path $Destination 'README.md') -Force
  $packageScripts = Join-Path $Destination 'scripts'
  New-Item -ItemType Directory -Path $packageScripts -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo "scripts\package-engine-$version.ps1") -Destination $packageScripts -Force
  if ($version -ne '3.2') {
    Copy-Item -LiteralPath (Join-Path $repo 'scripts\package-engine-3.2.ps1') -Destination $packageScripts -Force
  }
  @(
    'target/',
    'outputs/',
    '*.log',
    '*.local',
    '.DS_Store'
  ) | Set-Content -LiteralPath (Join-Path $Destination '.gitignore') -Encoding ascii

  if ($GitHub) {
    $workflow = Join-Path $Destination '.github\workflows'
    New-Item -ItemType Directory -Path $workflow -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo '.github\workflows\engine-native.yml') -Destination $workflow -Force
  }

  foreach ($excluded in @('node_modules', 'target', 'Library', 'Build', 'outputs')) {
    $found = Get-ChildItem -LiteralPath $Destination -Directory -Force |
      Where-Object Name -eq $excluded |
      Select-Object -First 1
    if ($found) {
      throw "Excluded directory entered source package: $($found.FullName)"
    }
  }
  $cache = Get-ChildItem -LiteralPath $Destination -Recurse -Force |
    Where-Object { $_.Name -eq '__pycache__' -or $_.Extension -eq '.pyc' } |
    Select-Object -First 1
  if ($cache) {
    throw "Python cache entered source package: $($cache.FullName)"
  }
}

function Assert-NativeOnly([string]$Directory) {
  $forbiddenPathPattern = '(?i)^(unity|unityplayer(?:\.dll)?|unitycrashhandler(?:32|64)?(?:\.exe)?|urdr_data|monobleedingedge|urdr map\.exe)$'
  $forbiddenPath = Get-ChildItem -LiteralPath $Directory -Recurse -Force |
    Where-Object { $_.Name -match $forbiddenPathPattern } |
    Select-Object -First 1
  if ($forbiddenPath) {
    throw "External map runtime artifact entered package: $($forbiddenPath.FullName)"
  }

  $textFiles = Get-ChildItem -LiteralPath $Directory -File -Recurse -Force |
    Where-Object { $_.Extension -in @('.rs', '.toml', '.json', '.yml', '.yaml') }
  $forbiddenText = $textFiles |
    Select-String -Pattern '(?i)unityplayer|unitycrashhandler|monobleedingedge|urdr_data|urdr map\.exe|unity runtime' |
    Select-Object -First 1
  if ($forbiddenText) {
    throw "External map runtime reference entered package: $($forbiddenText.Path):$($forbiddenText.LineNumber)"
  }

  $meloArtifact = Get-ChildItem -LiteralPath $Directory -Recurse -Force |
    Where-Object { $_.FullName -match '(?i)MeloTTS' } |
    Select-Object -First 1
  if ($meloArtifact) {
    throw "MeloTTS artifact entered package: $($meloArtifact.FullName)"
  }
}

function Test-ImsSpeech([string]$Directory) {
  $speech = Join-Path $Directory 'Data\Speech\IMS-Toucan'
  $python = Join-Path $speech 'python\python.exe'
  $runner = Join-Path $speech 'runner\ims_toucan_runner.py'
  $worker = Join-Path $speech 'runner\ims_toucan_worker.py'
  $engine = Join-Path $speech 'engine'
  $model = Join-Path $speech 'Models\ToucanTTS.pt'
  $vocoder = Join-Path $speech 'Models\Vocoder.pt'
  foreach ($required in @($python, $runner, $worker, $model, $vocoder)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "IMS-Toucan runtime file is missing: $required"
    }
  }
  if ((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'b36d5d79669ef2b36b1edbf6196132ba95c9e6b03c799d679191e259fe561a59') {
    throw 'ToucanTTS.pt checksum mismatch.'
  }
  if ((Get-FileHash -LiteralPath $vocoder -Algorithm SHA256).Hash.ToLowerInvariant() -ne '3f4fa1ea04b2f723cdf4b7fed3ccc73b07fd8dd84723f1e8bc7dee80094ffdbf') {
    throw 'Vocoder.pt checksum mismatch.'
  }
  $wave = Join-Path ([System.IO.Path]::GetTempPath()) "urdr-ims-$PID.wav"
  try {
    & $python -B $runner --ipa 'tɛst' --output $wave --engine-root $engine --language eng --model $model --vocoder $vocoder --speed 1 --pitch 1 --volume 0.85
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $wave) -or (Get-Item -LiteralPath $wave).Length -le 44) {
      throw 'Bundled IMS-Toucan synthesis diagnostic failed.'
    }
  } finally {
    if (Test-Path -LiteralPath $wave) {
      Remove-Item -LiteralPath $wave -Force
    }
  }
}

function Start-And-VerifyWindow([string]$Executable, [string]$WorkingDirectory) {
  $startedAt = Get-Date
  $process = Start-Process -FilePath $Executable -ArgumentList '--allow-multiple' -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
  try {
    $deadline = (Get-Date).AddSeconds(40)
    do {
      Start-Sleep -Milliseconds 250
      $process.Refresh()
    } until ($process.HasExited -or $process.MainWindowHandle -ne 0 -or (Get-Date) -ge $deadline)

    if ($process.HasExited) {
      throw "Portable host exited before creating a window: $($process.ExitCode)"
    }
    if ($process.MainWindowHandle -eq 0) {
      throw 'Portable host did not create a stable window within 40 seconds.'
    }

    Start-Sleep -Seconds 5
    $companions = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Id -ne $process.Id -and
      $_.StartTime -ge $startedAt -and
      $_.Path -and
      $_.Path.StartsWith($WorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase)
    })
    if ($companions.Count -gt 0) {
      throw "Portable client launched a separate process: $($companions.ProcessName -join ', ')"
    }
    $process.Refresh()
    if (-not $process.CloseMainWindow()) {
      throw 'Portable client did not accept a normal window-close request.'
    }
    if (-not $process.WaitForExit(20000)) {
      throw 'Portable client remained after a normal window-close request.'
    }
    if ($process.ExitCode -ne 0) {
      throw "Portable client returned a non-zero exit code: $($process.ExitCode)"
    }
  } finally {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit(10000) | Out-Null
    }
  }
}

function Test-Portable([string]$Executable, [string]$WorkingDirectory) {
  $diagnostic = Start-Process -FilePath $Executable -ArgumentList '--diagnose-demo' -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
  if (-not $diagnostic.WaitForExit(60000)) {
    Stop-Process -Id $diagnostic.Id -Force
    throw 'Native demo diagnostic did not exit within 60 seconds.'
  }
  if ($diagnostic.ExitCode -ne 0) {
    throw "Native demo diagnostic failed: $($diagnostic.ExitCode)"
  }

  if (-not $SkipLaunchTest) {
    Start-And-VerifyWindow $Executable $WorkingDirectory
    Start-Sleep -Milliseconds 750
    Start-And-VerifyWindow $Executable $WorkingDirectory
  }

  Start-Sleep -Milliseconds 750
  $leftovers = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($WorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($leftovers.Count -gt 0) {
    throw "Portable process remained after shutdown: $($leftovers.ProcessName -join ', ')"
  }
}

New-Item -ItemType Directory -Path $output -Force | Out-Null

$portableDirectory = Join-Path $output "URDR-Engine-v$version-Windows-x64-Portable"
$vscodeDirectory = Join-Path $output "URDR-Engine-v$version-VSCode-Source"
$githubDirectory = Join-Path $output "URDR-Engine-v$version-GitHub-Ready"
$portableZip = Join-Path $output "URDR-Engine-v$version-Windows-x64-Portable.zip"
$vscodeZip = Join-Path $output "URDR-Engine-v$version-VSCode-Source.zip"
$githubZip = Join-Path $output "URDR-Engine-v$version-GitHub-Ready.zip"
if ($ZipOnly) {
  foreach ($directory in @($portableDirectory, $vscodeDirectory, $githubDirectory)) {
    Remove-PackagingDirectory $directory
  }
  foreach ($archive in @($portableZip, $vscodeZip, $githubZip)) {
    Remove-PackagingFile $archive
  }
}

$nativeManifest = Get-Content -LiteralPath (Join-Path $repo 'native\urdr-wgpu\Cargo.toml') -Raw
$crateVersion = [regex]::Escape("$version.0")
if ($nativeManifest -notmatch "version\s*=\s*`"$crateVersion`"") {
  throw "Native crate version is not $version.0."
}
if ((Get-Content -LiteralPath (Join-Path $repo 'ENGINE_VERSION.txt') -Raw).Trim() -ne $version) {
  throw "ENGINE_VERSION.txt does not match $version."
}

$nativeExecutable = if ($env:URDR_NATIVE_EXECUTABLE) {
  [System.IO.Path]::GetFullPath($env:URDR_NATIVE_EXECUTABLE)
} elseif ($env:CARGO_TARGET_DIR) {
  Join-Path ([System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)) 'release\urdr-native.exe'
} else {
  Join-Path $repo 'native\urdr-wgpu\target\release\urdr-native.exe'
}
if (-not (Test-Path -LiteralPath $nativeExecutable)) {
  throw 'Release Rust executable is missing.'
}

Reset-Directory $portableDirectory
Copy-Item -LiteralPath $nativeExecutable -Destination (Join-Path $portableDirectory 'URDR.exe') -Force
if (-not $OmitLauncher) {
  Copy-Item -LiteralPath (Join-Path $repo 'START_URDR.cmd') -Destination $portableDirectory -Force
}
Copy-RuntimeResources $portableDirectory
Copy-ReleaseDocuments $portableDirectory
Assert-NativeOnly $portableDirectory
Test-ImsSpeech $portableDirectory
Test-Portable (Join-Path $portableDirectory 'URDR.exe') $portableDirectory
Remove-Item -LiteralPath (Join-Path $portableDirectory 'Logs') -Recurse -Force -ErrorAction SilentlyContinue
Write-Zip $portableDirectory $portableZip
if ($ZipOnly -and -not $KeepPortable) {
  Remove-PackagingDirectory $portableDirectory
}

if (-not $PortableOnly) {
  Copy-SourcePackage $vscodeDirectory $false
  Assert-NativeOnly $vscodeDirectory
  Write-Zip $vscodeDirectory $vscodeZip
  if ($ZipOnly) {
    Remove-PackagingDirectory $vscodeDirectory
  }

  Copy-SourcePackage $githubDirectory $true
  Assert-NativeOnly $githubDirectory
  Write-Zip $githubDirectory $githubZip
  if ($ZipOnly) {
    Remove-PackagingDirectory $githubDirectory
  }
}

$artifactPaths = @($portableZip)
if (-not $PortableOnly) {
  $artifactPaths += @($vscodeZip, $githubZip)
}
$artifacts = $artifactPaths | ForEach-Object { Get-Item -LiteralPath $_ }
$manifestPath = Join-Path $output "URDR-Engine-v$version-SHA256.txt"
$artifacts | Sort-Object Name | ForEach-Object {
  $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
  '{0}  {1}' -f $hash.Hash.ToLowerInvariant(), $_.Name
} | Set-Content -LiteralPath $manifestPath -Encoding ascii

[pscustomobject]@{
  Version = $version
  Output = $output
  ProcessModel = 'single-process'
  Artifacts = @($artifacts | ForEach-Object {
    [pscustomobject]@{
      Name = $_.Name
      Bytes = $_.Length
      Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  Manifest = $manifestPath
} | ConvertTo-Json -Depth 4
