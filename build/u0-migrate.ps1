param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][ValidateSet('CurrentUser', 'all')][string]$InstallMode,
  [Parameter(Mandatory = $true)][string]$AppDataRoot
)

$ErrorActionPreference = 'Stop'
$failureCode = 40

function File-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function Inventory([string]$Root) {
  $folder = Get-Item -LiteralPath $Root -Force
  if (-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Legacy data directory is not a regular directory'
  }
  # Build relative names from each entry rather than subtracting absolute path
  # lengths: Windows may mix an 8.3 root such as RUNNER~1 with long child paths.
  $lines = New-Object 'System.Collections.Generic.List[string]'
  Add-InventoryEntries -Directory $folder.FullName -RelativeDirectory '' -Lines $lines
  return ,@($lines.ToArray() | Sort-Object)
}

function Add-InventoryEntries([string]$Directory, [string]$RelativeDirectory, [System.Collections.Generic.List[string]]$Lines) {
  foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Legacy data contains a link: $($entry.FullName)"
    }
    $relative = if ($RelativeDirectory) { Join-Path $RelativeDirectory $entry.Name } else { $entry.Name }
    if ($entry.PSIsContainer) {
      Add-InventoryEntries -Directory $entry.FullName -RelativeDirectory $relative -Lines $Lines
    } else {
      $hash = File-Sha256 $entry.FullName
      [void]$Lines.Add("$relative|$($entry.Length)|$hash")
    }
  }
}

function Copy-Verified([string]$Source, [string]$Target) {
  $before = @(Inventory $Source)
  $replaceEmpty = $false
  if (Test-Path -LiteralPath $Target) {
    $existing = @(Inventory $Target)
    if (@(Compare-Object -ReferenceObject $before -DifferenceObject $existing).Count -eq 0) {
      return
    }
    if (@(Get-ChildItem -LiteralPath $Target -Force).Count -ne 0) {
      throw "Existing data target conflicts: $Target"
    }
    $replaceEmpty = $true
  }
  # Keep the sibling name short: Electron cache paths can reach MAX_PATH in
  # Windows Sandbox even when the final AppData path remains below the limit.
  $stage = Join-Path (Split-Path -Parent $Target) ('.u0-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
  if (Test-Path -LiteralPath $stage) { throw "Migration staging directory already exists: $stage" }
  Copy-Item -LiteralPath $Source -Destination $stage -Recurse -Force
  $copied = @(Inventory $stage)
  if (@(Compare-Object -ReferenceObject $before -DifferenceObject $copied).Count -ne 0) {
    throw "Data copy verification failed; original remains at $Source"
  }
  if ($replaceEmpty) {
    # A freshly launched legacy app may have created this empty AppData folder.
    # Remove-Item without -Recurse refuses it if another process added data.
    Remove-Item -LiteralPath $Target
  }
  if (Test-Path -LiteralPath $Target) { throw "Data target appeared while copying: $Target" }
  Move-Item -LiteralPath $stage -Destination $Target
  $committed = @(Inventory $Target)
  if (@(Compare-Object -ReferenceObject $before -DifferenceObject $committed).Count -ne 0) {
    throw "Committed data verification failed; original remains at $Source"
  }
}

try {
  $legacyData = Join-Path $InstallDir 'data'
  $legacyPointer = Join-Path $InstallDir 'data-location.json'
  $hasData = Test-Path -LiteralPath $legacyData
  if ($hasData) {
    $legacyInfo = Get-Item -LiteralPath $legacyData -Force
    if ($legacyInfo.PSIsContainer -and
        -not ($legacyInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
        @(Get-ChildItem -LiteralPath $legacyData -Force).Count -eq 0) {
      # The legacy installer creates this directory even when no account has
      # ever stored shared data there. An empty regular directory has no
      # profile ownership to guess and can be removed by the old uninstaller.
      $hasData = $false
    }
  }
  $hasPointer = Test-Path -LiteralPath $legacyPointer
  if (-not $hasData -and -not $hasPointer) { exit 0 }

  # Per-machine installations may have profiles belonging to several accounts.
  # Migrating that shared directory into the elevated account would hide data
  # from the other users. Stop before the old uninstaller runs.
  if ($InstallMode -eq 'all') {
    $failureCode = 42
    throw 'A per-machine install has legacy data inside its program directory; automatic migration requires account-specific recovery'
  }
  if (-not (Test-Path -LiteralPath $AppDataRoot -PathType Container)) {
    throw "AppData root is unavailable: $AppDataRoot"
  }

  $activeTarget = Join-Path $AppDataRoot 'jj-music'
  if ($hasPointer) {
    $pointerInfo = Get-Item -LiteralPath $legacyPointer -Force
    if ($pointerInfo.PSIsContainer -or ($pointerInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Legacy data pointer is not a regular file'
    }
    $pointer = Get-Content -LiteralPath $legacyPointer -Raw | ConvertFrom-Json
    if ($pointer.dir -isnot [string] -or $pointer.dir -notmatch '^[A-Za-z]:\\') {
      throw 'Legacy data pointer does not contain an absolute local directory'
    }
    $external = [IO.Path]::GetFullPath($pointer.dir).TrimEnd('\')
    $program = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    if ($external.Equals($program, [StringComparison]::OrdinalIgnoreCase) -or
        $external.StartsWith($program + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Legacy data pointer targets the installation directory'
    }
    if (-not (Test-Path -LiteralPath $external -PathType Container)) {
      throw "Legacy data pointer target is missing: $external"
    }
    $newPointer = Join-Path $AppDataRoot '.jj-music-data-location.json'
    if (Test-Path -LiteralPath $newPointer) {
      $existing = Get-Content -LiteralPath $newPointer -Raw | ConvertFrom-Json
      if ($existing.dir -ne $pointer.dir) { throw 'Existing AppData pointer conflicts with legacy pointer' }
    } else {
      $tempPointer = "$newPointer.u0-$([guid]::NewGuid().ToString('N'))"
      Copy-Item -LiteralPath $legacyPointer -Destination $tempPointer
      if ((File-Sha256 $legacyPointer) -ne (File-Sha256 $tempPointer)) {
        throw 'Legacy pointer copy verification failed'
      }
      Move-Item -LiteralPath $tempPointer -Destination $newPointer
    }
    # The old installation's fallback data is preserved separately; the
    # external pointer remains the active profile after installation.
    $activeTarget = Join-Path $AppDataRoot 'jj-music-u0-legacy-backup'
  }
  if ($hasData) { Copy-Verified $legacyData $activeTarget }
  Set-Content -LiteralPath (Join-Path $AppDataRoot 'jj-music-u0-migration.log') -Value "Verified legacy data migration from $InstallDir to $activeTarget"
  Write-Output "U0 migration verified: $activeTarget"
  exit 0
} catch {
  $message = "U0 migration stopped before uninstall: $($_.Exception.Message)"
  try { Set-Content -LiteralPath (Join-Path $AppDataRoot 'jj-music-u0-migration.log') -Value $message }
  catch { }
  Write-Output $message
  exit $failureCode
}
