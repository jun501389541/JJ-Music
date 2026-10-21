import { spawn } from 'node:child_process'

// Capture before the source host removes public process-spawning capabilities.
const spawnReaper = spawn.bind(null)
const reaperExecutable = process.execPath
const reaperEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined }
const encodeOwner = JSON.stringify.bind(JSON)
const reaperProgram = `(${Function.prototype.toString.call(reapOwnedScratch)})(JSON.parse(process.argv[1])).then(()=>{},()=>{})`
export interface ScratchOwner { directory: string; token: string; ownerPid: number; childPid: number }

/** Self-contained so the short-lived reaper needs no file in the directory it removes. */
export async function reapOwnedScratch(
  owner: ScratchOwner,
  options: { probe?: (pid: number) => 'dead' | 'alive' | 'unknown'; attempts?: number; delayMs?: number } = {}
): Promise<boolean> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const os = await import('node:os')
  const probe = options.probe ?? ((pid: number): 'dead' | 'alive' | 'unknown' => {
    try { process.kill(pid, 0); return 'alive' }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown' }
  })
  try {
    if (![owner.ownerPid, owner.childPid].every(pid => Number.isSafeInteger(pid) && pid > 0) ||
      owner.ownerPid === owner.childPid || !/^[a-f0-9-]{36}$/i.test(owner.token)) return false
    const root = await fs.realpath(os.tmpdir())
    const dir = path.resolve(owner.directory)
    if (path.dirname(dir) !== root || !/^jj-source-[A-Za-z0-9]+$/.test(path.basename(dir))) return false
    const valid = async (): Promise<boolean> => {
      const info = await fs.lstat(dir)
      if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(dir) !== dir) return false
      const marker = path.join(dir, '.jj-owner.json')
      const entry = await fs.lstat(marker)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024) return false
      const stored = JSON.parse(await fs.readFile(marker, 'utf8'))
      return stored.schema === 1 && stored.directory === owner.directory && stored.token === owner.token && stored.ownerPid === owner.ownerPid
    }
    if (!await valid()) return false
    for (let attempt = 0; attempt < (options.attempts ?? 50); attempt++) {
      if (probe(owner.ownerPid) !== 'dead') return false
      const child = probe(owner.childPid)
      if (child === 'unknown') return false
      if (child === 'dead') {
        // Refuse links anywhere in the owned tree; never follow them during inspection.
        let count = 0
        const inspect = async (current: string): Promise<boolean> => {
          if (++count > 10_000) return false
          const info = await fs.lstat(current)
          if (info.isSymbolicLink()) return false
          if (info.isDirectory()) {
            for (const name of await fs.readdir(current)) if (!await inspect(path.join(current, name))) return false
          } else if (!info.isFile()) return false
          return true
        }
        if (!await inspect(dir) || !await valid() || probe(owner.ownerPid) !== 'dead' || probe(owner.childPid) !== 'dead') return false
        await fs.rm(dir, { recursive: true, force: false })
        return true
      }
      await new Promise(resolveWait => setTimeout(resolveWait, options.delayMs ?? 100))
    }
  } catch { /* Uncertain ownership, process state or I/O always retains the directory. */ }
  return false
}

/** Called only after the host's private native owner probe has confirmed ESRCH. */
export function scheduleScratchReap(owner: ScratchOwner): void {
  try {
    const child = spawnReaper(reaperExecutable, ['-e', reaperProgram, encodeOwner(owner)], {
      detached: true, windowsHide: true, stdio: 'ignore',
      env: reaperEnvironment
    })
    child.on('error', () => { /* Failed launch retains scratch. */ })
    child.unref()
  } catch { /* Restricted environments may forbid a cleanup child. */ }
}
