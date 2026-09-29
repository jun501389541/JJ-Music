/**
 * 在沙箱可写的目录里安装 Electron 二进制。
 *
 * 为什么需要这个脚本，而不是直接 `node node_modules/electron/install.js`：
 * `install.js` 不传 `cacheRoot`，于是 `@electron/get` 落到 `envPaths('electron').cache`，
 * 在 win32 上即 `%LOCALAPPDATA%\electron\Cache` —— 本次会话的沙箱拒绝写用户目录
 * （`EPERM: mkdir 'C:\Users\jun\AppData\Local\electron'`）。
 *
 * `cacheRoot` 是 `downloadArtifact` 的**选项**而非环境变量（见
 * `node_modules/@electron/get/dist/index.js:111`），`env-paths` 在 win32 上也不读
 * `XDG_CACHE_HOME`（见 `node_modules/env-paths/index.js:21-33`）。所以只能由调用方
 * 显式指定。本脚本把它指到工作区内的 `.cache/electron`，与 `.npmrc` 把 npm cache
 * 放进 `.cache/npm` 是同一个理由。
 *
 * 镜像仍走环境变量 `ELECTRON_MIRROR`（`.npmrc` 的注释说明该键刻意留在环境里，
 * 因为 `@electron/get` 先读 `npm_config_*` 再读 `ELECTRON_MIRROR`，而仓库默认
 * 不应把每个人的下载都导向第三方镜像）。
 *
 * 用法：
 *   $env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
 *   node tools/install-electron.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const cacheRoot = join(repoRoot, '.cache', 'electron')
mkdirSync(cacheRoot, { recursive: true })

const version = require('electron/package.json').version
console.log(`electron ${version}`)
console.log(`cacheRoot ${cacheRoot}`)
console.log(`mirror    ${process.env.ELECTRON_MIRROR || '(official GitHub releases)'}`)

const { downloadArtifact } = await import('@electron/get')

const started = Date.now()
const zip = await downloadArtifact({
  version,
  artifactName: 'electron',
  platform: process.platform,
  arch: process.arch,
  cacheRoot
})
console.log(`downloaded in ${Math.round((Date.now() - started) / 1000)}s: ${zip}`)
if (!existsSync(zip)) {
  console.error('下载完成但文件不存在')
  process.exit(1)
}

// `electron` 的这个包把解压交给 postinstall；这里手工完成同一件事：
// 解压到 node_modules/electron/dist，并写出 path.txt（`electron/index.js` 靠它
// 定位可执行文件；它缺失正是"包在、二进制不在"的症状）。
// 具名导出，与 `node_modules/electron/install.js:5` 一致 —— 默认导出是别的东西。
const { extract } = await import('@electron-internal/extract-zip')
const { writeFileSync } = await import('node:fs')
const distDir = join(repoRoot, 'node_modules', 'electron', 'dist')
await extract(zip, { dir: distDir })
console.log(`extracted to ${distDir}`)

const executable = process.platform === 'win32' ? 'electron.exe' : 'electron'
if (!existsSync(join(distDir, executable))) {
  console.error(`解压后找不到 ${executable}`)
  process.exit(1)
}
writeFileSync(join(repoRoot, 'node_modules', 'electron', 'path.txt'), executable)
console.log(`wrote path.txt (${executable})`)
console.log('done')
