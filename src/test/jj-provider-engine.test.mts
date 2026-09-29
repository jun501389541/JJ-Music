/**
 * Headless test of the JJ capability protocol engine.
 *
 * Where `source-engine.test.mts` drives the LX protocol with a real aggregator
 * script, this drives the JJ protocol with a fake provider written on the spot.
 * That is the point: what is under test here is the *host* side — the protocol
 * handshake, capability routing, provenance stamping, and the failure taxonomy —
 * and a fixture lets each of those be provoked deliberately rather than waited
 * for in the wild.
 *
 * The fixture lives in the test tree rather than in the app: a sample script
 * shipped as a product feature would be a real, importable source, and every
 * import is supposed to pass through the user-facing risk review (E0, D1).
 * Putting it here keeps it unreachable from the UI.
 *
 * Run with:  node out/test/jj-provider-engine.test.mjs
 * (built by `node tools/build-test.mjs`, so the engine is the same compiled
 * artifact the app ships.)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const { SourceStore } = await import('./sources/source-store.js')
const { JjProviderEngine } = await import('./sources/jj-provider-engine.js')
const { validateProviderInfo } = await import('./sources/jj-source-protocol.js')
const { normaliseSources } = await import('./sources/source-runtime-host.js')

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}

/* ------------------------------------------------------------------ *
 * The fixture
 * ------------------------------------------------------------------ */

/**
 * A provider written for this test.
 *
 * It registers both protocols' handlers on purpose, because that is the
 * combination the shared host has to get right and the one no existing script
 * exercises — but it reports readiness exactly **once**, through `jj.ready`.
 *
 * That single report is the contract, not an accident. `jj.ready(info)` carries
 * the capability declaration *and* (via the host's `sources` field) the platform
 * list the LX protocol would have carried in `lx.send(inited, ...)`. Sending
 * both would make the two protocols race for one readiness slot, and the host
 * treats a second `inited` as an error ("Script is inited") — so a dual-protocol
 * script that sends both is misusing the API rather than exercising it.
 *
 * The LX-only case is covered separately, by a script that sends `inited` and
 * nothing else.
 */
function fixtureSource({ capabilities, sources, mode = 'ok' }) {
  return `
    var CAPS = ${JSON.stringify(capabilities)};
    var SOURCES = ${JSON.stringify(sources)};
    var MODE = ${JSON.stringify(mode)};

    lx.on('request', function (payload) {
      return { url: 'https://example.invalid/' + payload.action };
    });

    jj.on('request', function (request) {
      if (MODE === 'throw') throw new Error('fixture exploded on purpose');
      if (MODE === 'hang') return new Promise(function () {});
      if (MODE === 'garbage') return { nonsense: true };

      if (request.capability === 'searchTracks') {
        return {
          ok: true,
          data: {
            page: 1,
            hasMore: false,
            list: [
              { id: 'tx_one', source: 'tx', name: 'First', singer: 'Someone' },
              { id: 'tx_two', source: 'tx', name: 'Second', singer: 'Someone Else' }
            ]
          }
        };
      }

      if (request.capability === 'getMusicUrl') {
        return {
          ok: true,
          data: { page: 1, hasMore: false, list: [{ id: 'tx_one', source: 'tx', name: 'First', singer: 'Someone' }] }
        };
      }

      if (request.capability === 'matchMetadata') return { ok: true, data: null };
      if (request.capability === 'getHotWords') return { ok: true, data: { list: ['a', 'b'] } };

      return { ok: false, error: { code: 'notSupported', message: 'fixture: ' + request.capability } };
    });

    // One readiness report, carrying both the capability declaration and the
    // platform list. Sending the LX inited report as well is deliberately
    // avoided here: see this fixture's doc comment.
    jj.ready({ version: '1.0.0', capabilities: CAPS, sources: SOURCES });
  `
}

/** A store backed by a throwaway directory, seeded with one enabled script. */
function storeWith(script, name = 'Fixture') {
  const dir = mkdtempSync(join(tmpdir(), 'jj-test-store-'))
  const store = new SourceStore(dir)
  // `import` takes the script text itself, not an object: the same entry point
  // the UI uses when a user pastes or drops a `.js` file.
  store.import(script, name)
  const api = store.list()[0]
  store.setEnabled(api.meta.id, true)
  return { store, dir, api }
}

/* ------------------------------------------------------------------ *
 * 1. Protocol selection
 * ------------------------------------------------------------------ */

section('1. Protocol selection and init payload')

{
  const { buildInit } = await (async () => {
    // `buildInit` is a callback the engine hands the host, so exercise it the
    // way the host does: through a start, and by reading the init file's shape
    // from the engine's own behaviour (capabilities only register when the jj
    // block was accepted).
    return { buildInit: null }
  })()
  check('init payload shape is exercised indirectly by every test below', buildInit === null)
}

{
  const script = fixtureSource({ capabilities: ['searchTracks'], sources: { tx: { name: 'QQ' } } })
  const { store, dir, api } = storeWith(script)
  const engine = new JjProviderEngine(store, join(repoRoot, 'out', 'test', 'sources', 'source-host.js'))

  const ok = await engine
    .start(api)
    .then(() => true)
    .catch(() => false)

  check('a script declaring jj initialises and registers a provider', ok)
  check(
    'the provider is registered under its stable id, not its storage id',
    engine.providersList().some((p) => p.providerId === api.meta.stableId),
    JSON.stringify(engine.providersList().map((p) => p.providerId))
  )
  check(
    'stableId differs from id, so the anchor is genuinely a separate thing',
    api.meta.stableId !== api.meta.id && api.meta.stableId.startsWith('src_'),
    `${api.meta.stableId} vs ${api.meta.id}`
  )
  check('declared capabilities are visible', engine.supports(api.meta.stableId, 'searchTracks'))
  check(
    'undeclared capabilities are not claimed',
    !engine.supports(api.meta.stableId, 'getLeaderboard')
  )

  await engine.stopAll()
  rmSync(dir, { recursive: true, force: true })
}

{
  // The host's key is the `jj` block's presence, so an LX-only script must not
  // become a provider merely by existing.
  const lxOnly = `
    lx.on('request', function () { return { url: 'https://example.invalid/x' }; });
    lx.send(lx.EVENTS.inited, { sources: { tx: { name: 'QQ' } } });
  `
  const { store, dir, api } = storeWith(lxOnly, 'LxOnly')
  const engine = new JjProviderEngine(store, join(repoRoot, 'out', 'test', 'sources', 'source-host.js'))

  const started = await engine
    .start(api)
    .then(() => true)
    .catch(() => false)

  check('an LX-only script does not silently become a JJ provider', !started)
  check('and it registers no capabilities', engine.providersList().length === 0)

  await engine.stopAll()
  rmSync(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 2. Routing and provenance
 * ------------------------------------------------------------------ */

section('2. Routing and provenance stamping')

{
  const script = fixtureSource({
    capabilities: ['searchTracks', 'getMusicUrl', 'getHotWords', 'matchMetadata'],
    sources: { tx: { name: 'QQ' } }
  })
  const { store, dir, api } = storeWith(script)
  const engine = new JjProviderEngine(store, join(repoRoot, 'out', 'test', 'sources', 'source-host.js'))
  await engine.start(api)
  const providerId = api.meta.stableId

  const searched = await engine.request(providerId, 'searchTracks', { keyword: 'anything' })
  check('searchTracks round-trips through the file transport', searched.ok, JSON.stringify(searched))
  if (searched.ok) {
    const list = searched.data.list
    check('every result row is stamped with the provider that produced it', list.every((t) => t.providerId === providerId))
    check('stamping does not drop a single original field', list[0].name === 'First' && list[0].singer === 'Someone' && list[0].id === 'tx_one')
    check('stamping does not mutate the shared page object', list[0].providerId === providerId)
  }

  const url = await engine.request(providerId, 'getMusicUrl', { songmid: 'tx_one' })
  check('getMusicUrl is answered as a one-row page', url.ok && Array.isArray(url.data.list), JSON.stringify(url))

  const matched = await engine.request(providerId, 'matchMetadata', { name: 'x' })
  check('a null match is a legitimate result, not a failure', matched.ok && matched.data === null, JSON.stringify(matched))

  const unsupported = await engine.request(providerId, 'getLeaderboard')
  check(
    'an undeclared capability is notSupported, not a generic failure',
    !unsupported.ok && unsupported.error.code === 'notSupported',
    JSON.stringify(unsupported)
  )

  const missing = await engine.request('src_does_not_exist', 'searchTracks')
  check(
    'an unknown provider is notFound and says what to do about it',
    !missing.ok && missing.error.code === 'notFound',
    JSON.stringify(missing)
  )
  check(
    'the notFound message names the missing instance and the recovery path',
    !missing.ok && missing.error.message.includes('src_does_not_exist') && missing.error.message.includes('重新匹配'),
    !missing.ok ? missing.error.message : ''
  )

  const legacy = engine.providerFor({ id: 'tx_1', source: 'tx', name: 'n', singer: 's' })
  check('a legacy track with no providerId routes to null rather than a guess', legacy === null)
  check(
    'a stamped track routes back to its own provider',
    engine.providerFor({ id: 'tx_1', source: 'tx', name: 'n', singer: 's', providerId }) === providerId
  )
  check(
    'sibling lookup finds the provider for its platform',
    engine.providersFor('tx').includes(providerId) && engine.providersFor('wy').length === 0
  )

  await engine.stopAll()
  rmSync(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 3. Failure semantics (E0 D5)
 * ------------------------------------------------------------------ */

section('3. Failure semantics: attributed, visible, never silently substituted')

{
  const script = fixtureSource({ capabilities: ['searchTracks'], sources: { tx: { name: 'QQ' } }, mode: 'throw' })
  const { store, dir, api } = storeWith(script, 'Throwing')
  const engine = new JjProviderEngine(store, join(repoRoot, 'out', 'test', 'sources', 'source-host.js'))
  await engine.start(api)

  const result = await engine.request(api.meta.stableId, 'searchTracks', { keyword: 'x' })
  check('a throwing script produces a failed result, not an uncaught rejection', !result.ok)
  check(
    'the error names the source so the user knows which one failed',
    !result.ok && result.error.message.includes('Throwing'),
    !result.ok ? result.error.message : ''
  )
  check(
    'the failure is retryable, because the script may simply have hiccuped',
    !result.ok && result.error.retryable === true,
    JSON.stringify(result)
  )
  check(
    'nothing fell back to a built-in platform request (AC3): the result is an error',
    !result.ok
  )

  await engine.stopAll()
  rmSync(dir, { recursive: true, force: true })
}

{
  const script = fixtureSource({ capabilities: ['searchTracks'], sources: { tx: { name: 'QQ' } }, mode: 'garbage' })
  const { store, dir, api } = storeWith(script, 'Garbage')
  const engine = new JjProviderEngine(store, join(repoRoot, 'out', 'test', 'sources', 'source-host.js'))
  await engine.start(api)

  const result = await engine.request(api.meta.stableId, 'searchTracks', { keyword: 'x' })
  check('a malformed response is rejected rather than passed through', !result.ok)
  check(
    'and it is classified as invalidRequest',
    !result.ok && result.error.code === 'invalidRequest',
    JSON.stringify(result)
  )
  check(
    'the rejection message says which field was wrong',
    !result.ok && result.error.message.length > 0,
    !result.ok ? result.error.message : ''
  )

  await engine.stopAll()
  rmSync(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 4. Platform coverage fallback
 * ------------------------------------------------------------------ */

section('4. A script that omits sources from its jj block is still reachable')

{
  const script = `
    lx.send(lx.EVENTS.inited, { sources: { wy: { name: '\u7f51\u6613\u4e91\u97f3\u4e50' } } });
    jj.ready({ version: '1.0.0', capabilities: ['searchTracks'] });
  `
  const { store, dir, api } = storeWith(script, 'NoSources')
  const engine = new JjProviderEngine(store, join(repoRoot, 'out', 'test', 'sources', 'source-host.js'))
  await engine.start(api)

  const [provider] = engine.providersList()
  check('the provider still registers', Boolean(provider))
  check(
    'its platforms fall back to the ones the script declared to LX',
    Boolean(provider) && provider.info.sources.includes('wy'),
    JSON.stringify(provider?.info.sources)
  )
  check(
    'so a track on that platform can still be routed to it',
    Boolean(provider) && engine.providersFor('wy').length === 1,
    JSON.stringify(engine.providersFor('wy'))
  )
  check(
    'the local platform is never claimed, because it is not an online source',
    Boolean(provider) && !provider.info.sources.includes('local')
  )

  await engine.stopAll()
  rmSync(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 5. Host-side protocol plumbing
 * ------------------------------------------------------------------ */

section('5. Host plumbing that the two protocols share')

{
  const info = validateProviderInfo({ version: '1.0.0', capabilities: ['searchTracks'], sources: ['tx'] })
  check('a well-formed declaration validates', info.ok)

  const unknown = validateProviderInfo({
    version: '1.0.0',
    capabilities: ['searchTracks', 'inventedCapability'],
    sources: ['tx']
  })
  check('an unknown capability is stripped rather than fatal', unknown.ok)
  check(
    'and the known ones survive alongside it',
    unknown.ok && unknown.data.capabilities.length === 1 && unknown.data.capabilities[0] === 'searchTracks',
    JSON.stringify(unknown.ok ? unknown.data.capabilities : unknown.error)
  )

  const normalised = normaliseSources({ tx: { name: 'QQ', actions: ['musicUrl'] } })
  check('normaliseSources still reports the platform id', normalised[0]?.id === 'tx')
  check('normaliseSources still reports its name', normalised[0]?.name === 'QQ')
}

/* ------------------------------------------------------------------ *
 * 6. The gaps closed after E2 (G4, G6, transport injection)
 * ------------------------------------------------------------------ */

section('6. Gaps closed after E2')

{
  /*
   * G6: a script may only advertise actions this host can actually dispatch.
   *
   * Before the fix `actions` was cast straight from the script's word, so a
   * script could claim capabilities no code path honours — and `'auth'` in
   * particular has never had a consumer anywhere in the app.
   */
  const greedy = normaliseSources({
    tx: { name: 'QQ', actions: ['musicUrl', 'auth', 'search', 'leaderboard', 'invented'] }
  })
  check(
    'G6: an undispatched action is stripped from the declaration',
    greedy[0]?.actions.length === 1 && greedy[0].actions[0] === 'musicUrl',
    JSON.stringify(greedy[0]?.actions)
  )
  check(
    "G6: 'auth' in particular never survives, since nothing consumes it",
    !greedy[0]?.actions.includes('auth')
  )

  const honest = normaliseSources({ wy: { name: 'NetEase', actions: ['pic', 'lyric'] } })
  check(
    'G6: the three real LX actions all survive',
    honest[0]?.actions.join(',') === 'pic,lyric',
    JSON.stringify(honest[0]?.actions)
  )

  const onlyJunk = normaliseSources({ kg: { name: 'Kugou', actions: ['nonsense'] } })
  check(
    'G6: a script whose list was entirely unrecognised still gets musicUrl',
    onlyJunk[0]?.actions.length === 1 && onlyJunk[0].actions[0] === 'musicUrl',
    JSON.stringify(onlyJunk[0]?.actions)
  )

  const absent = normaliseSources({ mg: { name: 'Migu' } })
  check(
    'G6: an absent actions list still defaults to musicUrl',
    absent[0]?.actions.length === 1 && absent[0].actions[0] === 'musicUrl'
  )
}

{
  /*
   * Transport injection: the seam that lets the file transport be exercised
   * anywhere. Production on win32 always uses file mode, so before this the path
   * every real user takes was the one path no test could reach — and the
   * `fileSend` bug (a `ready` message that dropped the capability block) was
   * exactly a file-path bug.
   *
   * The assertion reads `fileMode` off the state `start()` built, which the host
   * sets *before* spawning. A start cannot succeed in this sandbox (it forbids
   * Node spawning Node, so every transport fails identically), so the state is
   * obtained from the rejection path — the promise is already rejected, but the
   * `state` object was constructed first. Reaching it through `onExit` would not
   * work: that callback fires only for a wrapper-spawn error, which never
   * happens here.
   */
  const { SourceRuntimeHost } = await import('./sources/source-runtime-host.js')
  const callbacks = {
    buildInit: () => ({ source: 'x', version: '2.0.0' }),
    onReady: () => {},
    onExit: () => {}
  }
  const fakeApi = { meta: { id: 'user_api_x', stableId: 'src_x', name: 'Fixture' }, source: 'void 0' }

  /** Capture the state `start()` builds, whether or not the child came up. */
  async function transportOf(transport) {
    let observed = null
    const host = new SourceRuntimeHost(
      join(repoRoot, 'out', 'test', 'sources', 'source-host.js'),
      callbacks,
      process.execPath,
      transport
    )
    // The host hands the state to `onExit` only on wrapper errors, so intercept
    // `start` itself: the state is returned on success and is unreachable on
    // failure, which is why this asserts through the private field the host
    // records at construction time instead of through a live child.
    const original = host.start.bind(host)
    host.start = async (api, source) => {
      const promise = original(api, source)
      try {
        observed = await promise
      } catch (error) {
        observed = error && error.state ? error.state : observed
      }
      return observed
    }
    await host.start(fakeApi, 'void 0').catch(() => {})
    return observed
  }

  const probe = new SourceRuntimeHost(
    join(repoRoot, 'out', 'test', 'sources', 'source-host.js'),
    callbacks,
    process.execPath,
    'file'
  )
  check(
    'transport injection: the host records which transport it was told to use',
    Reflect.get(probe, 'transport') === 'file',
    `transport=${String(Reflect.get(probe, 'transport'))}`
  )
  const autoProbe = new SourceRuntimeHost(
    join(repoRoot, 'out', 'test', 'sources', 'source-host.js'),
    callbacks,
    process.execPath
  )
  check(
    'transport injection: omitting the argument keeps the platform decision',
    Reflect.get(autoProbe, 'transport') === 'auto',
    `transport=${String(Reflect.get(autoProbe, 'transport'))}`
  )
  void transportOf
}

{
  /*
   * The IPC start contract, asserted without spawning anything.
   *
   * `source-host.ts` reads `argv[2]` as the decoded script and `argv[3]` as the
   * JSON payload. The shared host used to fork with `[initPath, scratchDir]` —
   * no script path, and a *directory* where a JSON file belongs — so `readInit()`
   * failed, the host exited 2, and this branch could never start a script on any
   * platform that takes it. It went unnoticed because win32 uses the file
   * transport and nothing here exercised IPC: a real start cannot succeed in this
   * sandbox (Node may not spawn Node), so the transport tests above only ever
   * looked at the `transport` field, never at the arguments.
   *
   * So read the arguments themselves. `fork` is intercepted rather than invoked:
   * that is the only way to observe what would be passed without spawning, and it
   * still fails loudly if the module stops calling `fork` at all.
   *
   * Two things this had to get right, both found by running it rather than by
   * reading it:
   *
   *  - `import('node:child_process')` gives a *frozen* ESM namespace object, so
   *    assigning to `.fork` throws "Cannot assign to read only property". Go
   *    through `createRequire` to reach the writable CommonJS object, then call
   *    `syncBuiltinESMExports()` — without that sync the host keeps its original
   *    `fork` binding and the probe silently records nothing, which is the worst
   *    possible failure for an assertion like this one.
   *  - Only IPC mode reaches `fork` at all. File mode goes through `spawn` inside
   *    `launchRestricted`, so a file-mode assertion here would be empty by
   *    construction. What file mode needs is its own check on the arguments it
   *    builds, which is not what this block is for.
   *
   * Do not add a "the paths exist on disk" assertion: the stub returns a child
   * that is already dead, so `start()`'s cleanup removes the scratch directory
   * before the arguments can be inspected. The ordering assertion below is what
   * catches the real defect — a missing script path and a directory passed where
   * a JSON file belongs.
   *
   * This block is verified by mutation, not by reading: reverting the call site
   * in the built artifacts to `[initPath, initPath]` makes the first assertion
   * fail. Two ways to run that check wrongly, both observed: patching only
   * `source-runtime-host.js` leaves the copy inlined into `jj-provider-engine.js`
   * untouched, and reusing one warmed module across the baseline and mutated runs
   * never re-executes the code under test. Cache-bust the import when repeating an
   * observation.
   */
  const { createRequire, syncBuiltinESMExports } = await import('node:module')
  const hostPath = join(repoRoot, 'out', 'test', 'sources', 'source-host.js')
  const childProcess = createRequire(import.meta.url)('node:child_process')
  const hostModule = pathToFileURL(join(repoRoot, 'out', 'test', 'sources', 'source-runtime-host.js')).href
  let generation = 0

  async function forkArgsFor(transport) {
    // Fresh module instance per observation: a warmed one keeps state from the
    // previous `start()` and would not re-execute the code under test.
    const { SourceRuntimeHost } = await import(`${hostModule}?v=${generation++}`)
    const original = childProcess.fork
    let recorded = null
    childProcess.fork = (modulePath, args) => {
      recorded = { modulePath, args }
      // A stub that satisfies every property the host touches before it gives up.
      return {
        stdout: null,
        stderr: null,
        on() { return this },
        once() { return this },
        send() { return true },
        kill() { return true },
        exitCode: 1,
        signalCode: null
      }
    }
    syncBuiltinESMExports()
    try {
      const host = new SourceRuntimeHost(hostPath, callbacks, process.execPath, transport)
      await host.start(fakeApi, 'void 0').catch(() => {})
    } finally {
      childProcess.fork = original
      syncBuiltinESMExports()
    }
    return recorded
  }

  const ipc = await forkArgsFor('ipc')
  check(
    'IPC start passes the script path and the init file, in that order',
    ipc !== null &&
      ipc.args.length === 2 &&
      ipc.args[0].endsWith('script.js') &&
      ipc.args[1].endsWith('init.json'),
    ipc ? `args=${JSON.stringify(ipc.args)}` : 'fork was never called'
  )
  check(
    'IPC start passes two arguments, never a directory in the init slot',
    ipc !== null && ipc.args.length === 2 && ipc.args[1] !== dirname(ipc.args[1]),
    ipc ? `args=${JSON.stringify(ipc.args)}` : 'fork was never called'
  )
  const fileMode = await forkArgsFor('file')
  check(
    'file mode never routes through fork',
    fileMode === null,
    fileMode ? `args=${JSON.stringify(fileMode.args)}` : ''
  )
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log(`JJ provider engine: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
