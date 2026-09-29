/**
 * Update checking and rollback for imported 音源 scripts.
 *
 * ## What this is for
 *
 * A source script goes stale: the platform changes its signing, the author
 * pushes a fix. Until now the only way to pick that up was to notice a broken
 * search, hunt down the author's page again, and re-import by hand — and a
 * re-import that mints a fresh `id` orphans every track already stamped with
 * the old one.
 *
 * ## The four rules this module is built around
 *
 * 1. **Never silent.** A check reports; only the user applies. Nothing here
 *    replaces a script on its own, and `apply` is a separate call the UI makes
 *    after showing what it is about to overwrite.
 *
 * 2. **Identity survives.** The replacement goes through
 *    `SourceStore.importScript(..., { stableId })`, which matches the existing
 *    record by `stableId` rather than by name. Without that, an author rename
 *    would mint a new id and the user's library would come back "source
 *    missing" — the exact failure `stableId` was introduced to prevent.
 *
 * 3. **The download is untrusted.** The URL comes from a script's `@homepage`,
 *    i.e. from a third party. It goes through `safeFetchBytes`, which validates
 *    every redirect hop, refuses private and metadata addresses at connection
 *    time (see `pinned-dispatcher.ts`), and caps the body. A hostile or
 *    misconfigured homepage cannot turn an update check into an SSRF.
 *
 * 4. **A checksum is not a signature.** The fetched script is hashed and the
 *    hash is reported, so a user who already knows the expected value can
 *    confirm it — but nothing here proves *who* published the bytes. The
 *    homepage is not authenticated, and there is no publisher identity to check
 *    it against. Presenting SHA-256 as provenance would be a lie, so this
 *    module documents what it does and does not establish (see `sha256`).
 *
 * ## What is deliberately absent
 *
 * - **No HTML scraping.** `@homepage` is used only when it points straight at a
 *   script. A homepage that returns a web page yields "this address does not
 *   serve a script" rather than a guess about which link on the page might be
 *   the download. Picking a link out of HTML has no reliable predicate, and
 *   guessing wrong means installing something the user never chose.
 * - **No automatic polling.** Nothing here runs on a timer; a check happens
 *   because the user asked for one.
 * - **No version downgrade.** `planUpdate` refuses to move backwards, so a
 *   compromised homepage cannot push a user onto an older, vulnerable script by
 *   advertising a low version.
 */
import { createHash } from 'node:crypto'
import { describeScript, assessScriptRisk, type ScriptRiskReport } from './script-header'
import { safeFetchBytes } from '../online/url-guard'

/**
 * Upper bound on a script fetched during an update check.
 *
 * Matched to `IPC.sourcesImportUrl`, which already caps a pasted script link at
 * the same value: the largest real 音源 sampled in this repository is ~740 KB,
 * so 4 MiB leaves room for a large aggregator without accepting an unbounded
 * body. A separate number is not introduced — an update and a first import are
 * the same download, and a second cap would only be a place for them to drift.
 */
export const MAX_UPDATE_BYTES = 4 * 1024 * 1024

/** Reasons an update check can end without offering an update. */
export type UpdateCheckFailure =
  | 'noHomepage'
  | 'notAUrl'
  | 'blocked'
  | 'empty'
  | 'notAScript'
  | 'notNewer'
  | 'sameVersion'

/** Outcome of comparing a fetched script against the installed one. */
export interface UpdatePlan {
  /** Version string currently installed, as parsed from the stored script. */
  currentVersion: string
  /** Version string advertised by the fetched script. */
  nextVersion: string
  /** The fetched script text, ready to be applied. */
  script: string
  /** `sha256:<hex>` of the fetched bytes. Verifies transfer, not authorship. */
  sha256: string
  /** Bytes downloaded. */
  bytes: number
  /** URL the script was fetched from. */
  url: string
  /** Risk rating of the *incoming* script, to compare against the installed one. */
  risk: ScriptRiskReport
}

export interface UpdateCheckResult {
  ok: boolean
  reason?: UpdateCheckFailure
  message?: string
  plan?: UpdatePlan
}

/* ------------------------------------------------------------------ *
 * Version comparison
 * ------------------------------------------------------------------ */

/**
 * Parse a version string into comparable numeric parts.
 *
 * ## Why the app updater's parser is not reused
 *
 * `src/main/updates/manifest.ts` compares versions with a strict
 * `^\d+\.\d+\.\d+$` regex. That is right for this application's own releases,
 * which are generated — but real 音源 headers are hand-written and this
 * repository's own fixtures carry `3.2.0`, `1` and `v1.2.1`. The strict parser
 * would reject most of them, and a version check that cannot read the version
 * it is comparing is worse than none.
 *
 * So: strip a leading `v`, split on dots, and keep the leading integer of each
 * part, dropping any pre-release suffix (`1.2.1-beta.3` → `1,2,1`). A part with
 * no leading digits ends the parse, so `1.2.beta` compares as `1.2`.
 *
 * Deliberately numeric-only: `1.10` is newer than `1.9`, which string
 * comparison gets wrong.
 */
export function parseVersion(value: string): number[] {
  // Cut at the first pre-release or build separator: `1.2.1-beta.3` is a
  // pre-release of `1.2.1`, so the `3` after the `-` must not make it newer.
  const cleaned = value.trim().replace(/^v/i, '').split(/[-+]/, 1)[0] ?? ''
  if (!cleaned) return []
  const parts: number[] = []
  for (const chunk of cleaned.split('.')) {
    const match = /^\s*(\d+)/.exec(chunk)
    if (!match) break
    parts.push(Number(match[1]))
  }
  return parts
}

/**
 * Compare two version strings.
 *
 * Returns a positive number when `next` is newer than `current`, negative when
 * older, and 0 when they are equal after normalisation.
 *
 * ## An unreadable version never wins
 *
 * When the *installed* version cannot be parsed but the incoming one can, the
 * incoming script is treated as newer — an author who starts writing real
 * versions is an improvement, and refusing would strand the user. When the
 * *incoming* version cannot be parsed, the result is 0 (not newer): a homepage
 * that returns an unparsable string must not be able to overwrite a working
 * script, and "unparsable" is not evidence of a fix.
 */
export function compareVersions(current: string, next: string): number {
  const a = parseVersion(current)
  const b = parseVersion(next)
  if (b.length === 0) return 0
  if (a.length === 0) return 1
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    // A missing part counts as 0: `1.2` and `1.2.0` are the same version.
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return right - left
  }
  return 0
}

/* ------------------------------------------------------------------ *
 * Deciding whether bytes are a script
 * ------------------------------------------------------------------ */

/**
 * Does this text look like a JavaScript 音源 rather than a web page?
 *
 * ## Why a heuristic is acceptable here
 *
 * This gate does not decide whether code is *safe* — `validateSourceBeforeStart`
 * and the user's confirmation do that. It decides whether the bytes are worth
 * showing the user at all, and it is deliberately biased towards rejecting: a
 * false "no" costs the user one manual re-import, while a false "yes" offers
 * them an HTML page as an update to a working script.
 *
 * The strongest available signal is the script header: every real 音源 in this
 * ecosystem starts with a `/*! ... *\/` block carrying `@name` / `@version`.
 * Failing that, a body with no HTML document markers is accepted, because some
 * scripts ship without a header block.
 */
export function looksLikeScript(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  // An HTML document, by any of the usual openings.
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return false
  // A bare JSON envelope is not a script either.
  if (/^[{[]/.test(trimmed) && !/function|=>|var |let |const /.test(trimmed)) return false
  // A header block is decisive when present.
  if (/@name\s+\S/.test(trimmed.slice(0, 8192))) return true
  // Otherwise require enough code-shaped text to be worth offering.
  return /(function|=>|var |let |const |class )/.test(trimmed) && !/<\/html>/i.test(trimmed)
}

/* ------------------------------------------------------------------ *
 * Checking
 * ------------------------------------------------------------------ */

/** Injected so the check can be driven offline in tests. */
export type UpdateFetcher = (url: string) => Promise<{ body: Buffer }>

export interface UpdateSource {
  /** Version currently installed (already parsed from the stored script). */
  currentVersion: string
  /** `@homepage` from the installed script. */
  homepage: string
}

/**
 * Check whether a newer script is available at the source's homepage.
 *
 * Never throws for an expected condition — a missing homepage or an
 * unreachable host is a normal result, reported through `reason`/`message`.
 * The caller renders that; only a programming error escapes.
 */
export async function checkForUpdate(
  source: UpdateSource,
  fetchBytes: UpdateFetcher = safeFetchBytes
): Promise<UpdateCheckResult> {
  const homepage = source.homepage.trim()
  if (!homepage) {
    return {
      ok: false,
      reason: 'noHomepage',
      message: '该音源没有填写 @homepage，无法自动检查更新。请从作者发布页手动下载后重新导入。'
    }
  }

  let url: URL
  try {
    url = new URL(homepage)
  } catch {
    return {
      ok: false,
      reason: 'notAUrl',
      message: `@homepage「${homepage}」不是一个有效的 http(s) 链接，无法自动检查更新。`
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'notAUrl',
      message: `@homepage「${homepage}」不是 http(s) 链接，出于安全考虑不会请求它。`
    }
  }

  let fetched: { body: Buffer }
  try {
    fetched = await fetchBytes(url.toString())
  } catch (error) {
    /*
     * A refusal from the URL guard arrives here as well as a network failure,
     * and the guard's message is the more useful one ("目标解析到内部地址…"),
     * so it is passed through rather than flattened into "check failed".
     */
    return {
      ok: false,
      reason: 'blocked',
      message: `无法从 @homepage 获取脚本：${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (fetched.body.length === 0) {
    return { ok: false, reason: 'empty', message: `@homepage「${homepage}」返回了空内容。` }
  }

  const script = fetched.body.toString('utf8')
  if (!looksLikeScript(script)) {
    return {
      ok: false,
      reason: 'notAScript',
      message:
        `@homepage「${homepage}」返回的内容不是音源脚本（可能是网页或其它文件）。` +
        '请从作者发布页手动下载脚本后重新导入。'
    }
  }

  const header = describeScript(script)
  const nextVersion = header.version
  const comparison = compareVersions(source.currentVersion, nextVersion)

  if (comparison <= 0) {
    const same = comparison === 0
    return {
      ok: false,
      reason: same ? 'sameVersion' : 'notNewer',
      message: same
        ? `已是最新版本（${source.currentVersion || '未标注版本'}）。`
        : `@homepage 上的脚本版本（${nextVersion || '未标注'}）不比当前版本（${source.currentVersion || '未标注'}）新，已忽略。`
    }
  }

  return {
    ok: true,
    plan: {
      currentVersion: source.currentVersion,
      nextVersion,
      script,
      sha256: `sha256:${createHash('sha256').update(fetched.body).digest('hex')}`,
      bytes: fetched.body.length,
      url: url.toString(),
      risk: assessScriptRisk(script)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Rolling back
 * ------------------------------------------------------------------ */

/**
 * Describe what a rollback would restore, without doing it.
 *
 * Kept separate from the store so the UI can label the button ("恢复 v1.2.1")
 * before the user commits to it.
 */
export function describeRollback(stored: {
  previousScript?: string
  previousVersion?: string
}): { available: boolean; version?: string } {
  if (!stored.previousScript) return { available: false }
  return { available: true, version: stored.previousVersion || '（未标注版本）' }
}
