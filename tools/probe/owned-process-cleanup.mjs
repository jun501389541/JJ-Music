import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export async function stopOwnedExecutables(root) {
  assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
  assert.ok(basename(root).startsWith('jj-or8-delivery-'))
  assert.equal((await realpath(root)).toLowerCase(), resolve(root).toLowerCase())
  // Old runas hosts are detached from the application tree. Never infer their
  // PIDs from source files: match this fixture's exact executable paths and
  // acquire OS process handles before terminating those processes only.
  const command = `
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($env:OR8_CLEAN_ROOT)
$paths=@((Join-Path $root 'old-app/JJ Music.exe'),(Join-Path $root 'next-app/JJ Music.exe'))
$owned=@(Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Where-Object { $paths -icontains $_.Path })
foreach($p in $owned){$null=$p.SafeHandle;$p.Kill();if(-not $p.WaitForExit(5000)){throw 'Owned process did not stop'}}
$remaining=@(Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Where-Object { $paths -icontains $_.Path })
if($remaining.Count){throw 'Owned process still exists'}
Write-Output $owned.Count
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, OR8_CLEAN_ROOT: root }
  })
  assert.ifError(result.error); assert.equal(result.status, 0, 'Owned fixture process cleanup failed')
  return Number(result.stdout.trim())
}
