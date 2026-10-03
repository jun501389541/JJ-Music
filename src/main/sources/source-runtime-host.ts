/**
 * Shared subprocess host for source scripts.
 *
 * ## Why this module exists
 *
 * JJ ships two source protocols:
 *
 *   - the LX-compatible one (`source-engine.ts`, `CUSTOM_SOURCE_API_VERSION`),
 *     which nearly every third-party 音源 in the wild speaks; and
 *   - the JJ capability protocol (`jj-source-protocol.ts`,
 *     `JJ_SOURCE_API_VERSION`), which moves search/playlist/leaderboard work
 *     out of the host and into the script.
 *
 * Both need the *same* hostile-input machinery: a detached restricted-token
 * child, a scratch directory used as a file transport, a heartbeat watchdog, a
 * memory limit, and crash reaping. Writing that twice would produce two
 * subprocess lifecycle implementations that must stay behaviourally identical
 * but would drift the first time one of them was fixed — and a fix applied to
 * only one copy is invisible until a source crashes in production.
 *
 * So the machinery lives here, once, and each engine keeps only its *policy*:
 * what to validate before starting, what a crash means, how to order owners,
 * and what goes in `init.json`.
 *
 * ## The split, stated as a rule
 *
 * This module performs no policy. It never decides that a script is bad, never
 * touches `SourceStore`, and never chooses between protocols. Everything
 * judgement-shaped is supplied by the caller through `HostCallbacks`. If you
 * find yourself wanting to add a `store.` call here, that is the signal the
 * logic belongs in the engine instead.
 */

import { fork } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Quality, SourceAction, SourceId, SourceInfo, OnlineMusicInfo } from '@shared/types'
import { LX_QUALITIES } from '@shared/types'
import type { LoadedApi } from './source-store'
import type { RestrictedLaunch } from './restricted-launch'
import {
  supportsRestrictedLaunch,
  launchRestricted,
  writeRequest,
  readResponse,
  readReady,
  readHeartbeat,
  readConsoleLog,
  killChildTree
} from './restricted-launch'

/* ------------------------------------------------------------------ *
 * Limits
 *
 * These are the values the LX engine has shipped with, moved here
 * verbatim so both engines inherit the same tolerances. See the long
 * comments at each use site for why they are what they are — the
 * heartbeat margin in particular is the product of a real incident.
 * ------------------------------------------------------------------ */

/** How long a script gets to report `inited` before it is considered broken. */
export const INIT_TIMEOUT_MS = 15_000
/** How long a single request may take before it is rejected. */
export const REQUEST_TIMEOUT_MS = 20_000
/** Child-process memory ceiling; a runaway script is killed, not the app. */
export const SOURCE_MEMORY_LIMIT_MB = 512
/** Simultaneous `fork()` calls during startup. */
export const START_CONCURRENCY = 4
/**
 * How many heartbeats may be missed before the child is treated as dead.
 *
 * The child's event loop is shared with the source script, so a 740 KB
 * obfuscated script blocks it for seconds while it decrypts and evaluates.
 * A 5 s limit at a 1 s heartbeat tolerates ~4 misses, which is far too few —
 * that is not a hypothetical, it is the cause of an incident where sources
 * collectively missed the init timeout because their own evaluation had
 * stalled the loop. 1 s × 20 = 19 misses absorbed, and 20 s lands on the
 * request ceiling so "request hung" and "process died" surface together
 * instead of the watchdog winning the race and killing a source that was
 * about to answer.
 */
export const HEARTBEAT_SILENCE_LIMIT_MS = 20_000
/** Poll granularity for the file transport. Imperceptible against a 20 s ceiling. */
const POLL_MS = 200
/** Console lines retained per script for the settings page. */
/**
 * Console ring-buffer ceiling, in lines.
 *
 * Exported so the engines bound their own log views with the same number the
 * host uses when it pushes lines itself; two different ceilings would make the
 * settings page show a different amount of history depending on which party
 * happened to capture a given line.
 */
export const MAX_LOG_LINES = 200

/**
 * Ceiling on one response payload, in bytes, measured after serialisation.
 *
 * The 512 MB child limit does **not** protect the main process: it bounds what a
 * script may allocate in *its own* process, while the payload travels back over
 * IPC and is parsed into the main process's heap. A script that returns a
 * 400 MB string is killed by its own memory limit only after the host has
 * already been asked to materialise it, and a payload that is merely large
 * (rather than fatal) is copied and parsed here without ever tripping the
 * child's ceiling at all.
 *
 * 8 MiB matches the value `online/cover-fetch.ts` already uses for fetched
 * bodies, so the codebase keeps one number for "a response this app will hold"
 * instead of growing a second, differently-motivated limit. Real payloads are
 * far below it: a 200-track page of `OnlineMusicInfo` is a few hundred KB.
 *
 * Rejecting rather than truncating is deliberate — a truncated page/lyric is
 * silently wrong data (a half-delivered search result, a lyric cut mid-line),
 * and wrong data is worse than a visible failure the user can retry.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * Measure a resolved response payload, without re-serialising it blindly.
 *
 * `JSON.stringify` throws on cycles and BigInt, which is itself the answer
 * (such a payload cannot have crossed IPC as JSON), so both are treated as
 * oversized — the failure mode is "reject the payload", never "throw out of the
 * message handler". String length is used rather than `Buffer.byteLength`
 * because this is only ever compared against a ceiling: an underestimate on
 * multi-byte text would let a ~4× larger string through, which is still bounded
 * and cannot be used to exhaust memory the way the unlimited case could.
 */
function responseSize(value: unknown): number {
  if (value === undefined) return 0
  try {
    const serialised = JSON.stringify(value)
    return serialised === undefined ? 0 : serialised.length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** The child process handle, when there is one. File mode has none. */
export type HostChild = ReturnType<typeof fork>

/** Live state for one source script's child process. */
export interface RuntimeState {
  api: LoadedApi
  /**
   * The forked child, or `undefined` under the restricted launcher.
   *
   * `runas` launches a *detached* process, so there is no handle to send IPC
   * over, observe `exit` on, or signal — file mode tracks liveness through the
   * heartbeat file instead. Keeping the field optional makes that asymmetry
   * visible in the type rather than hiding it behind a cast.
   */
  child?: HostChild
  /** The restricted launcher wrapper, present only in file mode. */
  wrapper?: RestrictedLaunch['wrapper']
  /** Directory holding this script's temp handoff file; removed on stop. */
  scratchDir: string
  sources: SourceInfo[]
  ready: Promise<void>
  pending: Map<number, PendingRequest>
  nextId: number
  /** Set when the process died; further requests fail fast. */
  dead: boolean
  logs: string[]
  stopFileLifecycle?: () => void
  /**
   * Set when the exit looked like a hard kill rather than a clean shutdown, so
   * the UI can explain it instead of showing a generic failure.
   */
  crashReason?: string
  /** True when this launch used the restricted-token file transport. */
  fileMode: boolean
  /**
   * The protocol-specific block a script reported alongside its sources.
   *
   * The host does not read this — it only carries it from the `ready` message
   * to the engine, which is the party that knows what the block means. Without
   * somewhere to put it the field would be dropped at the transport boundary,
   * and the engine would have to re-derive protocol state from nothing.
   */
  protocolInfo?: unknown
}

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  /** True when a `stop()` initiated the shutdown rather than a fault. */
  intentional: boolean
  /** Human-readable reason, already classified as abort / self-exit / plain. */
  reason: string
  /** True when the exit looked like a hard kill rather than a clean shutdown. */
  aborted: boolean
}

/**
 * Everything the host needs from the engine, and nothing more.
 *
 * Deliberately narrow: each callback is a question the host cannot answer
 * without knowing the protocol, so asking is cheaper than duplicating the
 * lifecycle.
 */
export interface HostCallbacks {
  /**
   * Contents of `init.json`.
   *
   * This is the one place the two protocols materially differ: the JJ engine
   * emits `{ source, version: '2.0.0', apiId, env, scriptInfo, jj: { … } }`,
   * while the LX engine emits `{ env, version: '2.0.0', apiId, scriptInfo }`
   * with **no `source` key at all** — scripts branch on the presence of what
   * they expect, and adding a field one of them never sent is a protocol change
   * dressed up as a refactor. The host writes whatever it is given and does not
   * interpret it, which is what keeps protocol knowledge out of the shared
   * machinery.
   *
   * `source` is therefore optional, and deliberately so: it was required while
   * only the JJ engine used this host, and requiring it would force the LX
   * caller to invent a value rather than reproduce its own payload verbatim.
   */
  buildInit(api: LoadedApi): { source?: string; version: string } & Record<string, unknown>
  /**
   * A script reported its sources.
   *
   * The host has already normalised them onto the runtime; the engine decides
   * how to index and announce them.
   */
  onReady(state: RuntimeState): void
  /**
   * The child died in a way the engine should surface.
   *
   * `intentional` is true when `stop()` initiated this, so a clean shutdown is
   * never reported as a crash. The host has already marked the runtime dead and
   * failed its pending requests by the time this runs.
   */
  onExit(state: RuntimeState, info: ExitInfo): void
  /** Console output from the child, already trimmed and split. */
  onLog?(apiId: string, line: string): void
  /** LX script authors may send a user-facing update notice during startup. */
  onUpdateAlert?(state: RuntimeState, data: unknown): void
}

/** Message shapes the host understands over IPC. */
interface HostMessage {
  type: string
  id?: number
  sources?: Record<string, unknown>
  /**
   * The protocol-specific block a script sends with `ready`.
   *
   * Kept untyped and unexamined on purpose: the host must carry it without
   * learning what is inside, or protocol knowledge leaks into the shared
   * machinery that both engines depend on.
   */
  jj?: unknown
  data?: unknown
  error?: string
  level?: string
  message?: string
}

/**
 * Owns the child process for one script.
 *
 * One instance per script. The engine keeps a map of these and routes requests
 * to them; nothing here knows what a capability or an LX action is.
 */
export class SourceRuntimeHost {
  private readonly hostPath: string
  private readonly callbacks: HostCallbacks
  /**
   * Path to the Node/Electron binary the restricted launcher should run.
   *
   * Injected so the launcher chain stays testable and so the host does not
   * reach for `process.execPath` in a module the tests import.
   */
  private readonly nodeExec: string
  /**
   * Forces the transport, instead of deriving it from the running platform.
   *
   * The transport is chosen by whether the restricted launcher is available,
   * which is a *platform* property (`supportsRestrictedLaunch()` is true only on
   * win32). That made the file transport — the one production actually uses on
   * Windows — untestable off-Windows, and untestable by construction on any
   * machine that is not the target: a bug in the file path (a `ready` message
   * losing the capability block, say) could pass the whole suite on CI and only
   * appear for real users.
   *
   * `'auto'` keeps the platform decision. `'file'` and `'ipc'` exist so a test
   * can pin a transport and exercise it anywhere. This is the seam that was
   * missing, not a new behaviour: nothing about production changes.
   */
  private readonly transport: 'auto' | 'file' | 'ipc'

  constructor(
    hostPath: string,
    callbacks: HostCallbacks,
    nodeExec: string = process.execPath,
    transport: 'auto' | 'file' | 'ipc' = 'auto'
  ) {
    this.hostPath = hostPath
    this.callbacks = callbacks
    this.nodeExec = nodeExec
    this.transport = transport
  }

  /**
   * Launch a script and resolve once it has reported in.
   *
   * Takes the script's *source*, not a path: the host owns the scratch
   * directory and is the only party that may clean it up, so it is also the
   * right place to materialise the file. A caller-supplied path would put the
   * script outside the directory this class deletes, leaving it behind.
   *
   * Rejects with the failure reason; the caller decides what that means. The
   * child is always reaped before rejecting, so a script stuck mid-init cannot
   * hold a process and 512 MB until the app exits.
   */
  async start(api: LoadedApi, scriptSource: string): Promise<RuntimeState> {
    /*
     * Check the host entry point before forking anything.
     *
     * A packaged build keeps `source-host.js` outside the asar (electron-builder
     * `asarUnpack`); when that step is missed, `fork` fails with a bare ENOENT
     * that says nothing about packaging, and the script gets blamed. Naming the
     * missing path is the difference between a five-minute fix and an afternoon.
     */
    if (!existsSync(this.hostPath)) {
      throw new Error(
        `音源运行时缺失: ${this.hostPath}\n` +
          `打包版本需要把 source-host.js 放在 asar 之外（electron-builder.yml 的 asarUnpack）。`
      )
    }

    const scratchDir = mkdtempSync(join(tmpdir(), 'jj-source-'))
    const scriptPath = join(scratchDir, 'script.js')
    writeFileSync(scriptPath, scriptSource, 'utf8')
    const initPath = join(scratchDir, 'init.json')
    writeFileSync(initPath, JSON.stringify(this.callbacks.buildInit(api)), 'utf8')

    const restricted = this.transport === 'auto' ? supportsRestrictedLaunch() : this.transport === 'file'
    const state: RuntimeState = {
      api,
      scratchDir,
      sources: [],
      ready: Promise.resolve(),
      pending: new Map(),
      nextId: 1,
      dead: false,
      logs: [],
      fileMode: restricted
    }

    if (restricted) {
      const launch = launchRestricted({
        nodeExec: this.nodeExec,
        hostPath: this.hostPath,
        scriptPath,
        initPath,
        scratchDir,
        memoryLimitMb: SOURCE_MEMORY_LIMIT_MB
      })
      state.wrapper = launch.wrapper
    } else {
      /*
       * `[scriptPath, initPath]` — in that order, matching the contract
       * `source-host.ts` documents at its `readInit()` (argv[2] is the decoded
       * script, argv[3] the JSON payload).
       *
       * This was `[initPath, scratchDir]` until 2026-09-28, which passed no
       * script path at all and put a *directory* where the host expected a JSON
       * file. `readInit()` cannot read it, returns null, and the host exits 2
       * ("nothing to do without an init payload") — so this branch had never
       * successfully started a single script on any platform that uses it.
       *
       * It survived because the file transport is what win32 takes, and
       * `launchRestricted` builds its arguments correctly from the same three
       * values; nothing exercised the IPC branch, and the missing argument is
       * the kind of thing a signature cannot catch: `fork(modulePath, args)` is
       * happy with any string array, so it fails at runtime inside the child,
       * where it looks like a broken script rather than a broken host.
       */
      state.child = fork(this.hostPath, [scriptPath, initPath], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        /*
         * Keep the working directory at the host file, never the scratch dir.
         *
         * The host `require`s `iconv-lite` and `music-metadata` while evaluating
         * the script. Node resolves bare specifiers relative to the requiring
         * file's real path, but a launcher whose cwd is the scratch dir makes
         * those lookups fail before the script ever runs — the child dies with
         * `Cannot find module 'iconv-lite'`, which reads like a broken source
         * rather than a broken launch.
         */
        cwd: dirname(this.hostPath),
        // A script that tries to allocate without bound should die on its own
        // rather than take the app down with it.
        execArgv: [`--max-old-space-size=${SOURCE_MEMORY_LIMIT_MB}`]
      })
    }

    state.ready = this.createReadyPromise(state)

    try {
      await state.ready
      return state
    } catch (error) {
      await this.teardown(state, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /**
   * Build the init promise and hand its settle function to the right lifecycle.
   *
   * The promise is created first because both lifecycles need to resolve it, and
   * whichever observes success or failure first wins — hence the idempotent
   * settle wrapper inside each.
   */
  private createReadyPromise(state: RuntimeState): Promise<void> {
    let settled = false
    let failure: Error | undefined

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const error = new Error(`音源初始化超时（${INIT_TIMEOUT_MS / 1000}s）`)
        failure = error
        reject(error)
      }, INIT_TIMEOUT_MS)

      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          failure = error
          reject(error)
        } else {
          resolve()
        }
      }

      // Stash the failure so `start` can reap with the real reason rather than
      // a generic one; the promise itself already carries it to the caller.
      void failure

      if (state.fileMode) {
        this.attachFileLifecycle(state, settle)
      } else {
        this.attachIpcLifecycle(state, settle)
      }
    })
  }

  /**
   * IPC mode: events arrive on the channel.
   *
   * This is the original path, preserved verbatim apart from the extraction, so
   * the two transports stay side by side and reviewable.
   */
  private attachIpcLifecycle(state: RuntimeState, settle: (error?: Error) => void): void {
    const child = state.child
    if (!child) return

    child.stdout?.on('data', (chunk: Buffer) => this.captureLog(state, chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.captureLog(state, chunk))

    child.on('message', (message: HostMessage) => this.handleMessage(state, message, settle))

    // A wrapper that failed to start at all (missing binary, refused policy)
    // should fail fast rather than wait out the init timeout.
    child.on('error', (error: Error) => {
      state.dead = true
      this.failAllPending(state, error)
      settle(error)
      this.callbacks.onExit(state, {
        code: null,
        signal: null,
        intentional: false,
        reason: error.message,
        aborted: false
      })
    })

    child.on('exit', (code, signal) => this.handleChildExit(state, code, signal, settle))
  }

  /**
   * File mode: the child is detached, so everything is observed through the
   * scratch directory — `ready.json`, `res-<id>.json`, and the heartbeat mtime.
   */
  private attachFileLifecycle(state: RuntimeState, settle: (error?: Error) => void): void {
    const dir = state.scratchDir
    let logOffset = 0
    let settled = false
    // LX specifies updateAlert at most once per script run, so the file
    // transport has one notification to consume rather than a stream/queue.
    let updateAlertRead = false

    const settleOnce = (error?: Error): void => {
      if (settled) return
      settled = true
      settle(error)
    }

    const drainLog = (): void => {
      const { text, nextOffset } = readConsoleLog(dir, logOffset)
      logOffset = nextOffset
      if (!text) return
      this.pushLog(state, text)
    }

    const watchdog = setInterval(() => this.checkHeartbeat(state, stopPoll), 1000)

    const poll = setInterval(() => {
      // Console output first, so an init error arrives with its context.
      drainLog()

      if (!updateAlertRead) {
        const alertPath = join(dir, 'update-alert.json')
        try {
          if (existsSync(alertPath)) {
            updateAlertRead = true
            const alert = JSON.parse(readFileSync(alertPath, 'utf8')) as { data?: unknown }
            this.callbacks.onUpdateAlert?.(state, alert.data)
          }
        } catch {
          // A partial/invalid notification is ignored; it cannot block startup.
          updateAlertRead = true
        }
      }

      const ready = readReady(dir)
      if (ready && !settled) {
        if (ready.ok === false) {
          const reason = `音源脚本执行出错（${ready.error ?? '未知原因'}）`
          state.crashReason = reason
          settleOnce(new Error(reason))
          stopPoll()
          return
        }
        state.sources = normaliseSources((ready.sources ?? {}) as Record<string, RawSourceInfo>)
        this.callbacks.onReady(state)
        settleOnce()
      }

      // A boot error that lands after ready.json already settled the lifecycle
      // is a late crash, not a failed start.
      if (ready?.ok === false && settled && !state.dead) {
        const reason = state.crashReason ?? `音源脚本执行出错（${ready.error ?? '未知原因'}）`
        state.crashReason = reason
        this.markDead(state, reason, stopPoll)
        return
      }

      for (const [id, pending] of [...state.pending]) {
        const response = readResponse(dir, id)
        if (!response) continue
        if (!response.ok) {
          pending.reject(new Error(response.error ?? '音源请求失败'))
          continue
        }
        // File mode needs the same ceiling as the IPC path: this is the transport
        // win32 actually uses (see `supportsRestrictedLaunch`), so leaving it
        // unchecked would guard the path production never takes.
        const size = responseSize(response.data)
        if (size > MAX_RESPONSE_BYTES) {
          pending.reject(
            new Error(
              `音源「${state.api.meta.name}」返回的数据过大（约 ${Math.round(size / 1048576)} MB，上限 ${MAX_RESPONSE_BYTES / 1048576} MB）`
            )
          )
          continue
        }
        pending.resolve(response.data)
      }
    }, POLL_MS)

    function stopPoll(): void {
      clearInterval(poll)
      clearInterval(watchdog)
    }

    state.stopFileLifecycle = stopPoll

    // The wrapper is the only process handle in file mode; if it cannot even be
    // spawned there is nothing to poll for.
    state.wrapper?.on('error', (error: Error) => {
      state.dead = true
      this.failAllPending(state, error)
      settleOnce(error)
      stopPoll()
      this.callbacks.onExit(state, {
        code: null,
        signal: null,
        intentional: false,
        reason: error.message,
        aborted: false
      })
    })
  }

  /**
   * File-mode liveness, derived from heartbeat freshness.
   *
   * The watchdog deliberately never removes the scratch directory: that
   * directory is the child's only channel, and deleting it under a live but
   * slow child makes its heartbeat write fail, turning a false positive into a
   * real death. Cleanup belongs to `stop()` and app exit, which are the only
   * moments a child's death is expected.
   */
  private checkHeartbeat(state: RuntimeState, stopPoll: () => void): void {
    if (state.dead) return
    const hb = readHeartbeat(state.scratchDir)
    // No heartbeat yet: the child has not started beating. Give it time.
    if (!hb) return
    const silence = Date.now() - hb.at
    if (silence <= HEARTBEAT_SILENCE_LIMIT_MS) return

    const reason =
      `音源进程已停止响应（心跳丢失 ${Math.round(silence / 1000)}s）。` +
      `可能是脚本崩溃或自行终止。已隔离，不影响其他音源。`
    this.markDead(state, reason, stopPoll)
  }

  /** Mark a runtime dead, fail its requests and tell the engine why. */
  private markDead(state: RuntimeState, reason: string, stopPoll: () => void): void {
    if (state.dead && state.crashReason) return
    state.dead = true
    const error = new Error(reason)
    this.failAllPending(state, error)
    this.callbacks.onExit(state, {
      code: null,
      signal: null,
      intentional: false,
      reason,
      aborted: false
    })
    stopPoll()
  }

  private handleMessage(
    state: RuntimeState,
    message: HostMessage,
    settle: (error?: Error) => void
  ): void {
    switch (message.type) {
      // The child reports `ready` once `lx.send(inited, …)` fires. Unlike LX we
      // do not treat a `status: false` field as failure: it was made obsolete in
      // LX 2.6 and current scripts still send `status: true` harmlessly, so
      // honouring it would fail sources that work fine.
      case 'ready': {
        // The IPC payload is `unknown` by construction — it comes off a
        // message channel — so the cast is the boundary where the host stops
        // trusting the transport and starts validating shape.
        state.sources = normaliseSources((message.sources ?? {}) as Record<string, RawSourceInfo>)
        state.protocolInfo = message.jj
        this.callbacks.onReady(state)
        settle()
        break
      }
      case 'boot-error':
        settle(new Error(message.error ?? '音源脚本执行出错'))
        break
      case 'update-alert':
        state.logs.push(`[update] ${JSON.stringify(message.data)}`)
        this.callbacks.onUpdateAlert?.(state, message.data)
        break
      case 'log':
        this.pushLog(state, `[${message.level ?? 'log'}] ${message.message ?? ''}`)
        break
      case 'response': {
        const pending = message.id !== undefined ? state.pending.get(message.id) : undefined
        if (!pending) return
        // Size-checked here, at the shared boundary, so both protocols inherit
        // the same ceiling — see `MAX_RESPONSE_BYTES` for why the child's own
        // memory limit does not cover this direction of travel.
        const size = responseSize(message.data)
        if (size > MAX_RESPONSE_BYTES) {
          pending.reject(
            new Error(
              `音源「${state.api.meta.name}」返回的数据过大（约 ${Math.round(size / 1048576)} MB，上限 ${MAX_RESPONSE_BYTES / 1048576} MB）`
            )
          )
          break
        }
        pending.resolve(message.data)
        break
      }
      case 'response-error': {
        const pending = message.id !== undefined ? state.pending.get(message.id) : undefined
        if (!pending) return
        pending.reject(new Error(message.error ?? '音源请求失败'))
        break
      }
      default:
        break
    }
  }

  /** Append console output, bounded, and forward it to the engine. */
  private pushLog(state: RuntimeState, text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      state.logs.push(trimmed)
      if (state.logs.length > MAX_LOG_LINES) state.logs.shift()
      this.callbacks.onLog?.(state.api.meta.id, trimmed)
    }
  }

  private captureLog(state: RuntimeState, chunk: Buffer): void {
    const text = chunk.toString('utf8').trim()
    if (text) this.pushLog(state, text)
  }

  private handleChildExit(
    state: RuntimeState,
    code: number | null,
    signal: NodeJS.Signals | null,
    settle: (error?: Error) => void
  ): void {
    // Read intent *before* marking dead: `stop()` marks the runtime dead first,
    // so a runtime that was already dead on entry is an intentional shutdown and
    // must not be reported as a crash.
    const intentional = state.dead
    state.dead = true

    // A signal, or the abort code Windows reports as a large unsigned value,
    // means the process was terminated rather than exiting cleanly.
    const aborted =
      signal !== null || code === null || code === 134 || code === 0xffffffff || code > 128

    const reason = aborted
      ? `音源进程被脚本强制终止${signal ? `（信号 ${signal}）` : ''}${code ? `（退出码 ${code}）` : ''}。` +
        `该脚本可能带有反调试/自我保护逻辑。已隔离，不影响其他音源。`
      : code === 1
        ? `音源进程退出（退出码 1）。脚本在初始化时结束了自己的进程，且没有输出任何错误信息 —— ` +
          `常见原因是环境自检失败（缺失的浏览器或 Node 全局对象），或脚本内置的自毁分支。` +
          `已隔离，不影响其他音源。`
        : `音源进程退出（退出码 ${code}）`

    state.crashReason = aborted ? reason : undefined
    const error = new Error(reason)
    this.failAllPending(state, error)

    if (code !== 0 || aborted) {
      settle(error)
    }
    this.callbacks.onExit(state, { code, signal, intentional, reason, aborted })

    // Reclaim the scratch directory once the process is gone.
    try {
      rmSync(state.scratchDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  failAllPending(state: RuntimeState, error: Error): void {
    for (const [, pending] of state.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    state.pending.clear()
  }

  /**
   * Mark a runtime dead, fail its in-flight requests and reclaim its process.
   *
   * Deliberately does not own the runtime map: a source that never finished
   * init is reaped through here too, and the settings page reads that record's
   * logs and crash reason afterwards.
   */
  async teardown(state: RuntimeState, reason: Error): Promise<void> {
    state.dead = true
    state.stopFileLifecycle?.()
    this.failAllPending(state, reason)

    // In file mode, removing the scratch directory is the shutdown signal: the
    // child's next heartbeat write fails and it stops beating. The child itself
    // is killed explicitly via the pid it reports in its heartbeat, because
    // runas detaches it beyond the reach of wrapper.kill().
    const hb = readHeartbeat(state.scratchDir)
    if (hb?.pid) killChildTree(hb.pid)

    try {
      rmSync(state.scratchDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }

    try {
      state.wrapper?.kill()
    } catch {
      /* already gone */
    }

    const child = state.child
    if (!child) return

    try {
      // SIGTERM first so the child can exit cleanly; kill() if it does not. In
      // file mode this reaches only the runas wrapper; the real child was
      // handled by the tree-kill above.
      child.kill()
      // A child that already exited cannot fire `exit` again, so without this
      // check the wait always ran to the 2 s SIGKILL fallback — which stalled
      // both restarting a crashed source (`start()` awaits `stop()`) and
      // quitting the app with one crashed (`before-quit` awaits `stopAll()`).
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolveStop) => {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              /* already gone */
            }
            resolveStop()
          }, 2000)
          child.once('exit', () => {
            clearTimeout(timer)
            resolveStop()
          })
        })
      }
    } catch {
      /* already gone */
    }
  }

  /**
   * Dispatch a request over whichever transport this runtime launched with.
   *
   * File mode wraps the payload into the `FileRequest` envelope that
   * `writeRequest` expects; IPC mode sends the raw payload, matching the shape
   * `source-host.ts` reads.
   */
  send(state: RuntimeState, id: number, source: string, action: string, info: unknown): void {
    if (state.fileMode) {
      writeRequest(state.scratchDir, { id, source, action, info })
    } else {
      state.child?.send({ type: 'request', id, payload: { source, action, info } })
    }
  }

  /**
   * Run one capability request and wait for its answer.
   *
   * The JJ protocol needs a request/response round trip, which `send` alone does
   * not provide — it only dispatches. The pending bookkeeping, the timeout and
   * the abort listener are the same mechanical concerns the LX engine's own
   * `requestFrom` implements, so they live here rather than being written a
   * second time in the engine.
   *
   * Rejects rather than returning a `JjResult`: mapping a failure onto a
   * protocol error code is policy, and policy belongs to the engine.
   */
  async request<T>(
    state: RuntimeState,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    if (state.dead) throw new Error(`音源「${state.api.meta.name}」已停止`)

    const id = state.nextId++
    return new Promise<T>((resolve, reject) => {
      const settle = (error?: Error, value?: unknown): void => {
        const pending = state.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        state.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value as T)
      }

      const onAbort = (): void => settle(new Error('音源请求已取消'))

      const timer = setTimeout(() => {
        settle(new Error(`音源请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`))
      }, REQUEST_TIMEOUT_MS)

      state.pending.set(id, { resolve: (value) => settle(undefined, value), reject: (error) => settle(error), timer })

      if (signal) {
        if (signal.aborted) return settle(new Error('音源请求已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        const lxSource = payload.source
        const lxAction = payload.action
        if (typeof lxSource === 'string' && typeof lxAction === 'string' && 'info' in payload) {
          // LX v2 sends one action request as `{ source, action, info }`. Keep
          // that wire shape intact; the JJ capability protocol below uses the
          // whole request object as its `info` payload.
          this.send(state, id, lxSource, lxAction, payload.info)
        } else {
          this.send(state, id, state.sources[0]?.id ?? '', String(payload.capability ?? ''), payload)
        }
      } catch (error) {
        // A dispatch failure is this request's failure, not an uncaught throw:
        // the caller awaits a result either way.
        settle(error as Error)
      }
    })
  }
}

/** Shape of what a script reports for one platform, before normalisation. */
interface RawSourceInfo {
  name?: string
  type?: string
  actions?: string[]
  qualitys?: Array<string | { type?: string }>
}

/** Display names for the platforms LX's custom-source API recognises. */
const PLATFORM_NAMES: Record<string, string> = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐',
  local: '本地音乐'
}

/**
 * The `actions` an LX-compatible script is allowed to advertise.
 *
 * `SourceAction` (in `@shared/types`) is the widest union and includes
 * `search`/`hotSearch`/`songList`/`leaderboard`/`tipSearch`/`auth`, none of which
 * this host dispatches: discovery, hot words, playlists and leaderboards are the
 * capability protocol's business, and `'auth'` has never had a consumer. Before
 * this check, a script's list was cast straight to `SourceAction[]`, so a script
 * could assert actions no code path can honour.
 *
 * Checking the name is what E0's decision D1-a requires: `actions` is a **routing
 * declaration, not a permission grant**, and an unrecognised name must be
 * stripped rather than carried. Stripping (not failing the source) is right
 * because the value is advisory — a script listing an extra action still serves
 * the three that matter, and refusing to start it would break sources that are
 * merely optimistic.
 */
const DISPATCHABLE_ACTIONS: readonly SourceAction[] = ['musicUrl', 'lyric', 'pic']

/**
 * Turn a script's raw `sources` map into the host's `SourceInfo[]`.
 *
 * Lives here rather than in `source-engine.ts` because both engines need it and
 * it is pure shape-work: no policy, no I/O, no store access. It is re-exported
 * from `source-engine.ts` so existing importers keep working — and that
 * re-export is now the *only* copy; a duplicate left in `source-engine.ts` is
 * what let the `actions` check below be applied to dead code first.
 *
 * Unknown platform ids are kept — a script may legitimately serve a platform
 * the host has never heard of, and dropping them means the platform disappears
 * from the UI even though the script can serve it. Nothing routes to an id
 * unless a source claims it, so keeping them is additive.
 *
 * `local` is the one exception: it is built in, and a script must not be able
 * to shadow the user's own files with a network-backed platform.
 *
 * A non-`music` type (a script advertising `type: 'video'`) is still dropped —
 * this app plays music, and listing a video source would offer the user a
 * platform whose every request fails.
 */
export function normaliseSources(raw: Record<string, RawSourceInfo>): SourceInfo[] {
  const out: SourceInfo[] = []
  for (const [id, info] of Object.entries(raw)) {
    if (!info || typeof info !== 'object') continue
    if (!id || id === 'local') continue
    // Absent type is treated as music, which is what an LX script means by
    // omitting it.
    if (info.type && info.type !== 'music') continue

    const declared = Array.isArray(info.qualitys)
      ? info.qualitys
          .map((q) => (typeof q === 'string' ? q : String((q as { type?: string })?.type ?? '')))
          .filter((q): q is Quality => Boolean(q))
      : []
    const qualitys = declared.filter((q) => LX_QUALITIES.includes(q))

    const declaredActions = Array.isArray(info.actions) ? info.actions : ['musicUrl']
    const actions = declaredActions.filter(
      (action): action is SourceAction => DISPATCHABLE_ACTIONS.includes(action as SourceAction)
    )

    out.push({
      id,
      // Known platforms get their Chinese name; a private id keeps the raw key
      // so the user can tell which script advertised it.
      name: PLATFORM_NAMES[id] ?? id,
      type: info.type || 'music',
      // Never advertise zero actions: a script whose list contained only
      // unrecognised names would otherwise look like a platform that cannot
      // play, and `getMusicUrl` would report "no source supports musicUrl"
      // rather than the real problem.
      actions: actions.length > 0 ? actions : ['musicUrl'],
      qualitys: qualitys.length > 0 ? qualitys : (['128k'] as Quality[])
    })
  }
  return out
}

/** Re-exported so callers do not need to know which module owns the type. */
export type { OnlineMusicInfo, SourceId }
