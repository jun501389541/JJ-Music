param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Installer / vswhere is required.' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or !$installation) { throw 'MSVC x64 build tools are required.' }
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars)) { throw 'vcvars64.bat is missing.' }
$output = Join-Path $projectRoot '.cache/windowless-wl0'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$batch = Join-Path $output 'build-argv-test.cmd'
$commands = @(
    '@echo off',
    ('call "' + $vcvars + '"'),
    'if errorlevel 1 exit /b 1',
    'cl /nologo /std:c++17 /utf-8 /EHsc native\source-launcher\argv-test.cpp /Fo.cache\windowless-wl0\argv-test.obj /Fe.cache\windowless-wl0\argv-test.exe',
    'if errorlevel 1 exit /b 1',
    '.cache\windowless-wl0\argv-test.exe',
    'if errorlevel 1 exit /b 1',
    'cl /nologo /std:c++17 /utf-8 /W4 /WX /EHsc /MT native\source-launcher\console-test.cpp /Fo.cache\windowless-wl0\console-test.obj /Fe.cache\windowless-wl0\console-test.exe user32.lib',
    'if errorlevel 1 exit /b 1',
    'cl /nologo /std:c++17 /utf-8 /W4 /WX /EHsc /MT native\source-launcher\window-watch.cpp /Fo.cache\windowless-wl0\window-watch.obj /Fe.cache\windowless-wl0\window-watch.exe user32.lib',
    'if errorlevel 1 exit /b 1',
    'cl /nologo /std:c++17 /utf-8 /W4 /WX /EHsc /MT native\source-launcher\window-positive.cpp /Fo.cache\windowless-wl0\window-positive.obj /Fe.cache\windowless-wl0\window-positive.exe /link /SUBSYSTEM:WINDOWS user32.lib',
    'if errorlevel 1 exit /b 1',
    'cl /nologo /std:c++17 /utf-8 /W4 /WX /EHsc /MT native\source-launcher\job-test.cpp /Fo.cache\windowless-wl0\job-test.obj /Fe.cache\windowless-wl0\job-test.exe',
    'exit /b %errorlevel%'
)
[IO.File]::WriteAllLines($batch, $commands, [Text.Encoding]::Default)
Push-Location $projectRoot
try {
    & $env:ComSpec /d /c $batch
    if ($LASTEXITCODE -ne 0) { throw "Native argv test failed: $LASTEXITCODE" }
} finally { Pop-Location }
