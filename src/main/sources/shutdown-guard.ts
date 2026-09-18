/**
 * System-shutdown watchdog.
 *
 * ## Why this exists
 *
 * A 音源 script shut the user's computer down. Windows' event log recorded the
 * cause exactly:
 *
 *   Event 1074 — `C:\Windows\system32\shutdown.exe` initiated 关机
 *   Reason Code: 0x800000ff
 *
 * `0xff` in the reason code is the "other / undefined" value a *programmatic*
 * shutdown produces; the Start menu produces `0x0`. It was logged in the same
 * second the source was enabled.
 *
 * No application can be made immune to a hostile script running with the
 * user's own privileges — that requires OS-level sandboxing this app does not
 * have. What an application *can* do is make the common path fail loudly and
 * reversibly instead of silently costing the user their session.
 *
 * ## What this does
 *
 * Before a script that is capable of this is started, the watchdog records the
 * pending-shutdown state, arms a monitor that notices a shutdown being
 * scheduled, and can abort it. Everything here is best-effort and must never
 * itself crash the app.
 *
 * ## What this deliberately does NOT do
 *
 * It does not detect "shutdown.exe" by polling the process list — that is
 * racy, and by the time `shutdown.exe` is observable the countdown has already
 * started. It uses the documented Win32 state instead:
 *
 *   - `shutdown /a` is the supported way to abort a pending shutdown, and it
 *     reports failure when there is nothing to abort.
 *   - Before starting a risky source we snapshot whether a shutdown is already
 *     pending, so we never claim credit for (or interfere with) a shutdown the
 *     user asked for.
 */

/** Runs a command; injected so this module is testable without spawning. */
export type CommandRunner = (
  file: string,
  args: string[]
) => Promise<{ code: number; stdout: string; stderr: string }>

/**
 * Attempt to cancel a shutdown that a source script triggered.
 *
 * Returns true only when the OS confirms the abort. `shutdown /a` fails when
 * nothing is pending, which is the normal case, so a false result is expected
 * and must not be treated as an error.
 *
 * This is the only lever the app has over a shutdown already in progress, and
 * it is best-effort: it works while the countdown is running, which is exactly
 * the window a script-triggered shutdown leaves.
 */
export async function abortPendingShutdown(run: CommandRunner): Promise<boolean> {
  try {
    const result = await run('shutdown', ['/a'])
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Command-line patterns that indicate a script is trying to power off the
 * machine. Used to give the user a *named* explanation when a source is
 * quarantined, not as the primary defence (the process lockdown is).
 */
const SHUTDOWN_PATTERNS: RegExp[] = [
  /shutdown(?:\.exe)?\s+\/[sSrR]/i,
  /ExitWindowsEx/i,
  /InitiateSystemShutdown/i,
  /NtShutdownSystem/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b\s+-[pf]/i
]

/**
 * Does this script text contain a recognisable shutdown invocation?
 *
 * Only the *decrypted* outer layer is visible to a static scan — obfuscated
 * string tables hide the rest — so a negative result is not proof of safety.
 * A positive result, however, is actionable and lets the app refuse the script
 * up front with a clear reason.
 */
export function containsShutdownAttempt(script: string): { found: boolean; match?: string } {
  for (const pattern of SHUTDOWN_PATTERNS) {
    const hit = pattern.exec(script)
    if (hit) return { found: true, match: hit[0] }
  }
  return { found: false }
}
