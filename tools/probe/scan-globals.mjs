/**
 * Inventory the host globals a real 音源 script references.
 *
 * LX runs scripts inside a hidden BrowserWindow, so a script may legitimately
 * touch `window`, `document`, `atob`, or `btoa`. Our sandbox is a Node worker
 * thread, which has none of those. This measures which ones actually appear so
 * we can decide what compatibility shims to provide.
 *
 * Usage: node tools/probe/scan-globals.mjs <script.js>
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/probe/scan-globals.mjs <script.js>')
  process.exit(1)
}

const source = readFileSync(file, 'utf8')

/**
 * Globals a script might use, grouped by which host provides them.
 * `browserOnly` entries are absent from a bare Node worker and therefore need
 * shims for full LX parity.
 */
const GLOBALS = {
  'available in Node workers': [
    'globalThis',
    'console',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'Promise',
    'JSON',
    'Math',
    'Date',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'fetch',
    'Buffer',
    'process',
    'structuredClone',
    'queueMicrotask',
    'AbortController'
  ],
  'browser-only (need shims)': [
    'window',
    'self',
    'document',
    'navigator',
    'location',
    'localStorage',
    'sessionStorage',
    'atob',
    'btoa',
    'XMLHttpRequest',
    'WebSocket',
    'Image',
    'Blob',
    'FileReader',
    'performance',
    'requestAnimationFrame',
    'crypto'
  ]
}

console.log(`scanning ${file} (${source.length} chars)\n`)

for (const [group, names] of Object.entries(GLOBALS)) {
  console.log(`--- ${group} ---`)
  const hits = []
  for (const name of names) {
    // Match the identifier not preceded by a dot (so `obj.window` is excluded)
    // and not followed by an identifier character.
    const pattern = new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\b`, 'g')
    const count = (source.match(pattern) ?? []).length
    if (count > 0) hits.push({ name, count })
  }
  hits.sort((a, b) => b.count - a.count)
  if (hits.length === 0) console.log('  (none)')
  for (const hit of hits) console.log(`  ${hit.name.padEnd(22)} ${hit.count}`)
  console.log('')
}

// Also report dynamic-code usage, which LX permits on desktop but not mobile.
console.log('--- dynamic code ---')
for (const name of ['eval', 'Function', 'new Function']) {
  const count = (source.match(new RegExp(`(?<![.\\w$])${name}\\b`, 'g')) ?? []).length
  console.log(`  ${name.padEnd(22)} ${count}`)
}
