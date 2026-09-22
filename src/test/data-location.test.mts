/**
 * Which directory the app's data lives in. Every rule here is a user-visible
 * outcome — a library that appears empty, a gigabyte of cache on C:, a gigabyte
 * written into node_modules — so each one is pinned separately.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { migrationSource, pointerPath, relocationProblem, resolveDataDir } from './data-location.js'

const APPDATA = 'C:/Users/me/AppData/Roaming/jj-music'
const EXE = 'D:/Apps/JJ Music'
const base = {
  switchDir: null, envDir: null, exeDir: EXE, appDataDir: APPDATA,
  packaged: true, pointer: null, exists: () => true, writable: () => true
}
const pick = over => resolveDataDir({ ...base, ...over })

test('a launcher-supplied --user-data-dir outranks every other rule', () => {
  // The harness launches a copy of the developer's profile. If the portable
  // default or a recorded pointer won, the run would read the real data instead —
  // which has already rewritten it once.
  const chosen = pick({ switchDir: 'E:/harness/profile', pointer: 'F:/moved/data' })
  assert.equal(chosen.dir, 'E:/harness/profile')
  assert.equal(chosen.source, 'switch')
})

test('the dev-only test data directory outranks the portable default', () => {
  const chosen = pick({ envDir: 'E:/tmp/user-data' })
  assert.equal(chosen.dir, 'E:/tmp/user-data')
  assert.equal(chosen.source, 'switch')
})

test('a recorded relocation wins over the folder next to the program', () => {
  const chosen = pick({ pointer: 'E:/JJ Music Data' })
  assert.equal(chosen.dir, 'E:/JJ Music Data')
  assert.equal(chosen.source, 'pointer')
  assert.equal(chosen.notice, null)
})

test('a relocation onto a drive that is not mounted says so instead of vanishing', () => {
  // 便携版把数据挪到别的盘、今天那块盘没插：绝不能转身在 C 盘另起一份库，
  // 那正是需求 2 要消灭的行为。回到程序旁边的 data/，并把话说清楚。
  const portable = pick({ pointer: 'E:/JJ Music Data', exists: path => path !== 'E:/JJ Music Data' })
  assert.equal(portable.dir, join(EXE, 'data'), 'it still has to start somewhere, and it starts next to the program')
  assert.equal(portable.source, 'portable')
  assert.ok(portable.notice?.includes('E:/JJ Music Data'), `notice names the missing path: ${portable.notice}`)
  assert.ok(portable.notice?.includes('程序旁边的数据目录'), JSON.stringify(portable.notice))
  // 装在只读目录里的安装版没有"程序旁边"可退，只能回系统目录，并且要说清楚回了哪。
  const installed = pick({ packaged: false, pointer: 'E:/JJ Music Data', exists: path => path !== 'E:/JJ Music Data' })
  assert.equal(installed.dir, APPDATA)
  assert.equal(installed.source, 'appdata')
  assert.ok(installed.notice?.includes('系统应用数据目录'), JSON.stringify(installed.notice))
})

test('an unreadable pointer is announced, not quietly ignored', () => {
  // Found while testing the portable build: a pointer file that fails to parse
  // used to fall through to the default with no trace, so a user who had moved
  // their data would find the app back on C: and no explanation.
  const portable = pick({ pointerProblem: 'Unexpected token \\ in JSON at position 12' })
  assert.equal(portable.source, 'portable', 'it still starts')
  assert.ok(portable.notice?.includes('Unexpected token'), JSON.stringify(portable.notice))
  const installed = pick({ packaged: false, pointerProblem: '坏掉了' })
  assert.ok(installed.notice?.includes('坏掉了'), JSON.stringify(installed.notice))
  assert.equal(pick({}).notice, null, 'no pointer at all is not a problem')
})

test('a packaged build with a writable program folder keeps its data there', () => {
  const chosen = pick({})
  assert.equal(chosen.dir, join(EXE, 'data'))
  assert.equal(chosen.source, 'portable')
})

test('an install under Program Files does not try to write next to the exe', () => {
  const chosen = pick({ exeDir: 'C:/Program Files/JJ Music', writable: () => false })
  assert.equal(chosen.dir, APPDATA)
  assert.equal(chosen.source, 'appdata')
})

test('development never writes into node_modules/electron/dist', () => {
  // `process.execPath` in dev is the Electron binary inside the repo, which is
  // writable — so the packaged flag is the only thing standing between a run and
  // a gigabyte of data inside the working tree.
  const chosen = pick({ packaged: false, exeDir: 'E:/repo/node_modules/electron/dist' })
  assert.equal(chosen.dir, APPDATA)
  assert.equal(chosen.source, 'appdata')
})

test('only a real move copies the old profile forward', () => {
  assert.equal(migrationSource(pick({}), APPDATA), APPDATA, 'portable over an installed profile')
  assert.equal(migrationSource(pick({ packaged: false }), APPDATA), null, 'nothing to migrate in dev')
  assert.equal(migrationSource(pick({ switchDir: 'E:/harness' }), APPDATA), null, 'a harness run must not touch the real data')
  assert.equal(migrationSource(pick({ pointer: APPDATA }), APPDATA), null, 'a pointer back at the default is not a move')
})

test('the pointer lives beside the exe only when that folder is writable', () => {
  assert.equal(pointerPath(EXE, APPDATA, () => true), join(EXE, 'data-location.json'))
  const fallback = pointerPath('C:/Program Files/JJ Music', APPDATA, () => false)
  assert.equal(fallback, join('C:/Users/me/AppData/Roaming', '.jj-music-data-location.json'))
  assert.notEqual(fallback, join(APPDATA, 'data-location.json'), 'not inside the directory being replaced')
})

test('一个记下的数据目录如果写不进去，就不能被当成数据目录采用', () => {
  // 路径上留了个同名普通文件、或者那块盘如今只读：光判 exists 会让应用把数据定在那儿，
  // 之后每一次保存都失败，而且界面上一句解释都没有。
  const readOnly = pick({ pointer: 'E:/JJ Music Data', writable: path => path !== 'E:/JJ Music Data' })
  assert.equal(readOnly.source, 'portable', '它还是要起在某个能写的地方')
  assert.ok(readOnly.notice?.includes('写不进去'), JSON.stringify(readOnly.notice))
  assert.ok(readOnly.notice?.includes('E:/JJ Music Data'), '并且要说清是哪个位置不行了')
  // 完全不在，仍然是"不可用"那句，不该说成写不进去。
  const missing = pick({ pointer: 'E:/JJ Music Data', exists: () => false })
  assert.ok(missing.notice?.includes('不可用'), JSON.stringify(missing.notice))
})

test('迁移目标不能与当前数据目录互相包含', () => {
  // `cp(current, target, {recursive:true})` 是一边走一边写：目标在当前目录里面，
  // 就会把新建出来的目录再复制进自己，一层层套到路径超长或盘写满为止。
  assert.equal(relocationProblem('D:/Apps/JJ Music/data', 'D:/Apps/JJ Music', true), 'nested')
  assert.equal(relocationProblem('D:\\Apps\\JJ Music\\data\\x', 'D:/Apps/JJ Music/', true), 'nested', '分隔符与结尾斜杠都要认')
  // 反方向同样不行：把数据挪到自己的上级，等于把应用的文件散到那个目录里。
  assert.equal(relocationProblem('D:/Apps', 'D:/Apps/JJ Music', true), 'nested')
  // 同一个目录用不同写法（大小写、斜杠、结尾分隔符）仍然是 same。
  assert.equal(relocationProblem('d:\\apps\\jj music\\', 'D:/Apps/JJ Music', true), 'same')
  // 只是名字开头相同的兄弟目录必须放过，否则「JJ Music 2」永远挪不动。
  assert.equal(relocationProblem('D:/Apps/JJ Music 2', 'D:/Apps/JJ Music', true), null)
  assert.equal(relocationProblem('E:/Data', 'D:/Apps/JJ Music', true), null)
  // 大小写敏感的文件系统上，只有真正同一个路径才算 same。
  assert.equal(relocationProblem('/data/JJ', '/data/jj', false), null)
  assert.equal(relocationProblem('/data/jj/', '/data/jj', false), 'same')
})
