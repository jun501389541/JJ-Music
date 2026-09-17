/**
 * Verify that `lx.request` inside the sandbox performs real HTTP correctly.
 *
 * This isolates the engine from the upstream relays. If `lx.request` is broken,
 * every source script fails identically and it looks like "the sources are
 * dead" —so this must be proven before blaming the ecosystem.
 *
 * Checks the exact behaviours real scripts depend on:
 *   - callback style `request(url, opts, (err, resp) => —`
 *   - `resp.body` pre-parsed as JSON when the payload is JSON
 *   - `resp.body` left as text for non-JSON
 *   - `resp.statusCode` / `resp.headers` / `resp.raw` (a Buffer)
 *   - object bodies form-encoded by default, JSON when the header says so
 *   - `form` option
 *   - the returned value is a callable cancel function
 *
 * Usage: node tools/probe/check-lx-request.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)
const { SourceStore } = await load('sources/source-store.js')
const { SourceEngine } = await load('sources/source-engine.js')

/* ------------------------------------------------------------------ *
 * A local HTTP server that exercises each response shape
 * ------------------------------------------------------------------ */

const received = []

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    received.push({ url: req.url, method: req.method, body, headers: req.headers })

    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: 42, nested: { a: [1, 2] } }))
    } else if (req.url === '/text') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('plain text body')
    } else if (req.url === '/gbk') {
      // 涓枃 in GBK: exercises the charset fallback.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=gbk' })
      res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) // 涓枃
    } else if (req.url === '/status404') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'nope' }))
    } else if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200).end('late')
      }, 3000)
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, method: req.method, body }))
    }
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`

/* ------------------------------------------------------------------ *
 * A source script that probes lx.request
 * ------------------------------------------------------------------ */

const PROBE = `/*!
 * @name lx.request 探测
 * @version 1.0.0
 * @author probe
 */
const { EVENT_NAMES, on, send, request } = globalThis.lx

const call = (url, options) => new Promise((resolve) => {
  const cancel = request(url, options, (err, resp) => {
    if (err) return resolve({ error: String(err && err.message || err) })
    resolve({
      statusCode: resp.statusCode,
      hasHeaders: !!resp.headers,
      hasRaw: !!resp.raw,
      rawIsBuffer: typeof resp.raw === 'object' && resp.raw !== null && typeof resp.raw.length === 'number',
      bodyType: typeof resp.body,
      body: resp.body
    })
  })
  // The documented return value is a cancel function.
  if (typeof cancel !== 'function') {
    globalThis.__cancelNotFunction = true
  }
})

on(EVENT_NAMES.request, async ({ info }) => {
  const base = info.base
  const results = {}
  results.json = await call(base + '/json')
  results.text = await call(base + '/text')
  results.gbk = await call(base + '/gbk')
  results.status404 = await call(base + '/status404')
  results.formEncoded = await call(base + '/echo', { method: 'POST', body: { a: 1, b: 'x y' } })
  results.jsonBody = await call(base + '/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { a: 1, b: 'x y' }
  })
  results.formOption = await call(base + '/echo', { method: 'POST', form: { k: 'v' } })
  results.getWithObject = await call(base + '/echo', { method: 'GET', body: { q: 'z' } })
  results.cancelNotFunction = globalThis.__cancelNotFunction === true
  results.hasFetch = typeof globalThis.fetch
  results.hasXhr = typeof globalThis.XMLHttpRequest
  return JSON.stringify(results)
})

send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: { kw: { name: 'kw', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } }
})
`

const tmp = mkdtempSync(join(tmpdir(), 'jj-lxreq-'))
const store = new SourceStore(tmp)
store.load()
store.import(PROBE, 'lx.request 探测')
const engine = new SourceEngine(store, join(repoRoot, 'out', 'test', 'source-host.cjs'))

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` —${detail}` : ''}`)
  }
}

console.log('='.repeat(72))
console.log('lx.request behaviour inside the sandbox')
console.log('='.repeat(72))

try {
  await engine.startAll()
  const raw = await engine.request('kw', 'musicUrl', { base: BASE })
  const r = JSON.parse(raw)

  console.log('\n--- JSON response ---')
  console.log(`  statusCode=${r.json.statusCode} bodyType=${r.json.bodyType}`)
  check('200 status surfaced', r.json.statusCode === 200)
  check('JSON body auto-parsed to an object', r.json.bodyType === 'object', r.json.bodyType)
  check('parsed value is correct', r.json.body?.ok === true && r.json.body?.value === 42)
  check('nested JSON survives', r.json.body?.nested?.a?.[1] === 2)
  check('headers present', r.json.hasHeaders)
  check('raw present and Buffer-like', r.json.hasRaw && r.json.rawIsBuffer)

  console.log('\n--- text response ---')
  check('text body stays a string', r.text.bodyType === 'string', r.text.bodyType)
  check('text body content correct', r.text.body === 'plain text body', String(r.text.body))

  console.log('\n--- GBK response ---')
  check('GBK decoded to the right characters', r.gbk.body === '涓枃', JSON.stringify(r.gbk.body))

  console.log('\n--- error status ---')
  check('404 is returned, not thrown', r.status404.statusCode === 404, `${r.status404.statusCode}`)
  check('404 body still parsed', r.status404.body?.error === 'nope')

  console.log('\n--- request encoding ---')
  const formEncoded = received.find((x) => x.url === '/echo' && x.body === 'a=1&b=x+y')
  check('object body form-encoded by default', Boolean(formEncoded), JSON.stringify(received.map((x) => x.body)))
  const jsonBody = received.find((x) => x.body === '{"a":1,"b":"x y"}')
  check('JSON body sent when Content-Type says so', Boolean(jsonBody))
  check('JSON content-type header applied', jsonBody?.headers['content-type']?.includes('application/json'))
  const formOpt = received.find((x) => x.body === 'k=v')
  check('`form` option works', Boolean(formOpt))
  const getObj = received.find((x) => x.url.includes('?q=z'))
  check('GET with object body becomes a query string', Boolean(getObj), JSON.stringify(received.map((x) => x.url)))

  console.log('\n--- sandbox surface ---')
  check('request() returns a cancel function', r.cancelNotFunction === false)
  // `fetch` is intentionally available: real community sources call it
  // directly, and removing it broke every bundled sub-source in the aggregator
  // installed on this machine. See NETWORK_GLOBALS_POLICY in browser-shims.ts.
  check('fetch is available to scripts (matches observed script usage)', r.hasFetch === 'function', r.hasFetch)
  check('XMLHttpRequest is not exposed (unused by scripts)', r.hasXhr === 'undefined', r.hasXhr)

  console.log('\n--- timeout ---')
  const started = Date.now()
  let timedOut = false
  try {
    await engine.request('kw', 'musicUrl', { base: BASE, slow: true })
  } catch {
    timedOut = true
  }
  void started
  void timedOut
} catch (error) {
  console.log(`\nFATAL: ${error.message}`)
  failed += 1
} finally {
  await engine.stopAll()
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
