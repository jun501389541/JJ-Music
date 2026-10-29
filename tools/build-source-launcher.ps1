param([switch]$TestBarrier)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'MSVC x64 build tools and Windows SDK are required.' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or !$installation) { throw 'MSVC x64 build tools are required.' }
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars)) { throw 'vcvars64.bat is missing.' }
$outputRelative = if ($TestBarrier) { '.cache/windowless-race' } else { 'build/native/x64' }
$output = Join-Path $projectRoot $outputRelative
New-Item -ItemType Directory -Force -Path $output | Out-Null
$batch = Join-Path $output 'build.cmd'
$testDefine = if ($TestBarrier) { '/DJJ_LAUNCHER_TEST_BARRIER' } else { '' }
$commands = @(
    '@echo off',
    ('call "' + $vcvars + '"'),
    'if errorlevel 1 exit /b 1',
    ('cl /nologo /std:c++17 /utf-8 /W4 /WX /EHsc /MT /O2 /D_WIN32_WINNT=0x0A00 ' + $testDefine + ' native\source-launcher\main.cpp /Fo' + $outputRelative + '\source-launcher.obj /Fe' + $outputRelative + '\source-launcher.exe /link /SUBSYSTEM:WINDOWS /MACHINE:X64 /DYNAMICBASE /NXCOMPAT /MANIFEST:EMBED /MANIFESTUAC:"level=''asInvoker'' uiAccess=''false''" Advapi32.lib Shell32.lib'),
    'exit /b %errorlevel%'
)
[IO.File]::WriteAllLines($batch, $commands, [Text.Encoding]::Default)
Push-Location $projectRoot
try {
    & $env:ComSpec /d /c $batch
    if ($LASTEXITCODE -ne 0) { throw "Native launcher build failed: $LASTEXITCODE" }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $output 'source-launcher.exe')))).Replace('-', '') }
    finally { $sha.Dispose() }
    @{ schema = 1; protocol = 1; arch = 'x64'; sha256 = $hash } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $output 'manifest.json')
} finally { Pop-Location }
