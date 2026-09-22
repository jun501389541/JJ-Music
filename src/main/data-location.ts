/**
 * Where the app keeps its data — settings, playlists, the library index, cover
 * art, source scripts, downloads metadata, and (because Electron derives them
 * from `userData`) Chromium's own cache.
 *
 * ## Why this is a separate, injectable module
 *
 * The answer depends on facts only the launching environment knows — was a
 * `--user-data-dir` passed, is this a packaged build, is the directory next to
 * the executable writable, did the user relocate once — and getting it wrong is
 * not a crash but a user who cannot find their library. So the decision is made
 * here as a pure function over injected probes and unit-tested, while
 * `index.ts` supplies the real filesystem and Electron paths.
 *
 * ## The order, and why
 *
 * An explicit `--user-data-dir` wins over everything: the test harness, the
 * smoke probe and the clean-profile check all launch a second instance against
 * a copied profile, and if the portable default outran them they would silently
 * read the developer's real data — which has already damaged it once.
 */
import { basename, dirname, join, resolve } from 'node:path'

/** Folder next to the executable that a portable build keeps its data in. */
export const PORTABLE_DIR = 'data'

/** File next to the executable recording a user-chosen data directory. */
export const POINTER_FILE = 'data-location.json'

export type DataDirSource = 'switch' | 'pointer' | 'portable' | 'appdata'

export interface DataDirInput {
  /** Absolute `--user-data-dir`, or null when the launcher did not pass one. */
  switchDir: string | null
  /** Dev-only `JJ_TEST_USER_DATA`, already gated by the caller. */
  envDir: string | null
  /** Directory containing the executable. */
  exeDir: string
  /** Electron's own default: `%APPDATA%/jj-music`. */
  appDataDir: string
  packaged: boolean
  /** Target recorded by an earlier relocation, or null. */
  pointer: string | null
  /**
   * Why a recorded pointer could not be read (corrupt file, bad path), or null.
   * A pointer that silently stops working is the "my library disappeared" class
   * of report, so the reason has to reach the settings page.
   */
  pointerProblem?: string | null
  exists: (path: string) => boolean
  writable: (path: string) => boolean
}

export interface DataDirChoice {
  dir: string
  source: DataDirSource
  /**
   * Set when a recorded relocation could not be honoured — the drive it lives on
   * is not mounted today. Surfaced in 设置·App 数据 rather than resolved silently:
   * falling back without a word is how "my library disappeared" gets reported.
   */
  notice: string | null
}

export function resolveDataDir(input: DataDirInput): DataDirChoice {
  if (input.switchDir) return { dir: input.switchDir, source: 'switch', notice: null }
  if (input.envDir) return { dir: input.envDir, source: 'switch', notice: null }
  // Computed before the pointer branch because it is also the fallback there.
  // A portable build is the case where "next to the program" is both possible and
  // what the user expects: they chose the folder they installed into. An installed
  // build under `Program Files` is not writable, and writing next to the exe in
  // development would drop a gigabyte of data into `node_modules/electron/dist`.
  const portable = input.packaged && input.writable(input.exeDir) ? join(input.exeDir, PORTABLE_DIR) : null
  if (input.pointer) {
    // 记下的目录必须**既在又能写**。只看 `exists` 的话，路径上留着一个同名普通文件、
    // 或者那块盘变成了只读挂载，都会被当成数据目录接受下来——然后每一次保存都失败，
    // 而用户看到的只是"我的曲库不见了"，正是 `notice` 这个字段存在要避免的那种沉默。
    if (input.exists(input.pointer) && input.writable(input.pointer)) {
      return { dir: input.pointer, source: 'pointer', notice: null }
    }
    // The drive the data lives on is not mounted today. A portable build must not
    // quietly start a second library on C: — that is the exact behaviour the data
    // directory exists to avoid — so it falls back to the folder beside the
    // program, which is also where the copy that migration left behind sits.
    const fallback = portable ?? input.appDataDir
    const why = input.exists(input.pointer) ? '该位置现在写不进去' : '该位置现在不可用'
    return {
      dir: fallback,
      source: portable ? 'portable' : 'appdata',
      notice: `上次把数据移到了 ${input.pointer}，${why}，本次使用的是${portable ? '程序旁边的数据目录' : '系统应用数据目录'}。`
    }
  }
  if (portable) {
    return {
      dir: portable, source: 'portable',
      notice: input.pointerProblem ? `数据位置记录读取失败（${input.pointerProblem}），本次使用的是程序目录。` : null
    }
  }
  return {
    dir: input.appDataDir, source: 'appdata',
    notice: input.pointerProblem ? `数据位置记录读取失败（${input.pointerProblem}），本次使用的是系统应用数据目录。` : null
  }
}

/**
 * Why `target` may not receive a copy of `current`, or null when it may.
 *
 * The relocation is a `cp(current, target, { recursive: true })`, and that walk
 * writes as it goes: pick a folder *inside* the data directory and it creates
 * the destination, descends into it, copies it into itself, and only stops when
 * the paths get too long or the disk fills up. The other direction is wrong the
 * same way — moving the data into its own parent scatters the app's files
 * alongside the folders that hold them.
 *
 * Windows paths are case-insensitive and accept either separator, so both are
 * normalised before the containment test; `caseInsensitive` is a parameter rather
 * than read from the platform so the two behaviours can be pinned by tests.
 */
export function relocationProblem(
  target: string,
  current: string,
  caseInsensitive = process.platform === 'win32'
): 'same' | 'nested' | null {
  const key = (path: string) => {
    // One separator and no trailing one, so `starts-with + '/'` is a real
    // containment test on a Windows path spelled any number of ways.
    const absolute = resolve(path).replace(/[\\/]+$/, '').replace(/\\/g, '/')
    return caseInsensitive ? absolute.toLowerCase() : absolute
  }
  const from = key(current)
  const to = key(target)
  if (from === to) return 'same'
  if (to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) return 'nested'
  return null
}

/** Where the relocation pointer is kept: next to the exe, or beside the old data. */
export function pointerPath(exeDir: string, appDataDir: string, writable: (path: string) => boolean): string {
  // The app-data directory's parent always exists by the time a relocation can
  // happen, while the executable's folder may be a read-only install location.
  return writable(exeDir)
    ? join(exeDir, POINTER_FILE)
    : join(dirname(appDataDir), `.${basename(appDataDir)}-${POINTER_FILE}`)
}

/**
 * The directory the legacy data lived in, when it is a *different* place from the
 * chosen one. Used for the one-time copy a portable build does over an existing
 * installed profile.
 */
export function migrationSource(chosen: DataDirChoice, appDataDir: string): string | null {
  if (chosen.source === 'appdata' || chosen.source === 'switch') return null
  if (chosen.dir === appDataDir) return null
  return appDataDir
}
