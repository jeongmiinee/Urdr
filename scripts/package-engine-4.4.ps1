param(
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs'),
  [switch]$SkipLaunchTest
)

$arguments = @{
  OutputRoot = $OutputRoot
  ReleaseVersion = '4.4'
  SkipLaunchTest = $SkipLaunchTest
  ZipOnly = $true
  KeepPortable = $true
  OmitLauncher = $true
  PortableOnly = $false
}
& (Join-Path $PSScriptRoot 'package-engine-3.2.ps1') @arguments
exit $LASTEXITCODE
