/**
 * Show where the dev-only E2E hook identifier appears in a renderer bundle.
 *
 * ⚠️ This is a TEXT SEARCH and its result is NOT a leak indicator.
 *
 * Vite compiles `import.meta.env['VITE_E2E'] === '1'` into a runtime property
 * read on an inlined env object, so the guarded assignment stays in the bundle
 * as a dead branch and the identifier `__jj_player` appears even in a perfectly
 * clean production build. Use `tools/probe/probe-hook.mjs` — which launches the
 * app and inspects `window` — to decide whether the hook is actually reachable.
 *
 * This tool is useful only for locating the emitted code while debugging.
 *
 * Usage: node tools/probe/inspect-hook.mjs [assetsDir]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const assetsDir = process.argv[2] ?? join(repoRoot, 'out', 'renderer', 'assets')

const html = readFileSync(join(repoRoot, 'out', 'renderer', 'index.html'), 'utf8')
const entry = /assets\/(index-[^"]+\.js)/.exec(html)?.[1]

console.log('TEXT SEARCH ONLY — not a leak indicator. Use probe-hook.mjs instead.\n')
console.log(`entry chunk referenced by index.html: ${entry ?? '(none)'}`)
console.log(`assets present: ${readdirSync(assetsDir).filter((n) => n.endsWith('.js')).length}\n`)

for (const name of readdirSync(assetsDir).filter((n) => n.endsWith('.js'))) {
  const source = readFileSync(join(assetsDir, name), 'utf8')
  const index = source.indexOf('__jj_player')
  if (index < 0) continue
  const referenced = name === entry
  console.log(`${referenced ? '(entry)' : '(other)'} ${name}`)
  console.log(`  ${JSON.stringify(source.slice(Math.max(0, index - 180), index + 120))}\n`)
}
