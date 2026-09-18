/**
 * Pre-flight validation for 音源 scripts.
 *
 * ## Why a separate layer
 *
 * The existing defences act *after* the decision to start: the process lockdown
 * removes capabilities once a script is running, and quarantine reacts to a
 * script that misbehaved. Both are necessary, but neither helps with the case
 * that motivated this module — **the user flips a switch by accident, and by
 * the time anything can react, the script has already run.**
 *
 * A script can only be stopped before it executes. So the checks here run at
 * the one moment where "no" is still cheap: between the user's intent and
 * `fork()`.
 *
 * ## Design constraints
 *
 * - **Never executes the script.** Validation is static analysis of text. A
 *   validator that runs the thing it is judging is not a validator.
 * - **Every check is explainable.** A refusal must name what it found, because
 *   a user who cannot understand a block will look for a way around it.
 * - **Findings are ordered by severity**, so the UI can say "blocked" versus
 *   "worth knowing" without re-deriving that from prose.
 * - **A clean result is not a guarantee.** Obfuscated string tables decrypt at
 *   runtime and are invisible here. This is documented rather than papered
 *   over, because overstating the guarantee is how users learn to ignore it.
 */

/** How serious a finding is. Drives whether a start is refused. */
import type {
  FindingSeverity,
  ValidationFinding,
  ValidationReport
} from '@shared/validation'

export type { FindingSeverity, ValidationFinding, ValidationReport } from '@shared/validation'

/**
 * Patterns that mean "this script can affect the machine, not just itself".
 *
 * Split by severity: a direct system call is a block, while a general
 * process-control surface is a warning the user may consciously accept.
 */
const SYSTEM_LEVEL_CHECKS: Array<{
  id: string
  severity: FindingSeverity
  title: string
  remedy: string
  pattern: RegExp
}> = [
  {
    id: 'shutdown-command',
    severity: 'block',
    title: '包含系统关机/重启命令',
    remedy: '除非你能确认这段代码是无害的，否则不要启动。建议删除该音源。',
    pattern: /shutdown(?:\.exe)?\s+\/[sSrRlL]/i
  },
  {
    id: 'win32-shutdown-api',
    severity: 'block',
    title: '调用 Windows 关机 API',
    remedy: '这是直接操作系统的接口，正常音源不需要它。建议删除该音源。',
    pattern: /ExitWindowsEx|InitiateSystemShutdown|NtShutdownSystem|RtlAdjustPrivilege/i
  },
  {
    id: 'shell-exec',
    severity: 'block',
    title: '尝试执行外部程序',
    remedy: '音源只需要发网络请求。执行本机程序属于超出职责的行为，不要启动。',
    // Deliberately narrower than "any `exec(`-shaped call": `String.exec` /
    // regex `.exec()` / user-defined helpers named `exec` are common in real
    // sources, and a bare `exec(` matched two working aggregators (星澜/墨澜).
    // Spawning requires the child_process module, so the module-load check
    // below catches the real path; requiring both `require('child_process')`
    // context AND a spawn/exec call keeps this rule high-precision.
    pattern: /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*(?:["'`]|process|Buffer)/
  },
  {
    id: 'process-spawn-module',
    severity: 'block',
    title: '加载进程创建模块',
    remedy: 'child_process / cluster 与在线播放无关，属于危险信号。',
    pattern: /child_process|node:child_process|\bcluster\b/
  },
  {
    id: 'process-termination',
    severity: 'block',
    title: '尝试终止自身进程',
    remedy: '这类脚本常在环境自检失败时静默自杀，属于自我保护型脚本，风险高。',
    pattern: /process\s*\.\s*(?:exit|abort|kill|reallyExit)\s*\(/
  },
  {
    id: 'native-binding',
    severity: 'block',
    title: '访问 Node 原生绑定',
    remedy: 'process.binding / dlopen 可绕过常规限制，正常音源不会使用。',
    pattern: /process\s*\.\s*(?:binding|dlopen|_linkedBinding)\s*\(/
  },
  {
    id: 'power-api',
    severity: 'block',
    title: '包含电源控制相关调用',
    remedy: '疑似电源管理操作。除非能确认用途，否则不要启动。',
    pattern: /\b(?:reboot|poweroff|hibernate|SetSuspendState)\s*\(/i
  }
]

/** Signals that are not proof of danger but change the risk calculus. */
const RISK_CHECKS: Array<{
  id: string
  severity: FindingSeverity
  title: string
  detail: (m: RegExpMatchArray, script: string) => string
  remedy: string
  pattern: RegExp
}> = [
  {
    id: 'server-authorised',
    severity: 'warn',
    title: '带服务端授权校验（远程控制开关）',
    detail: () =>
      '脚本内含服务端下发的配置（apiUrl / signSalt / fingerprint 之类）。' +
      '这类脚本的可用性和行为由远端决定，且部分会在检测到非授权宿主时采取对抗动作。',
    remedy: '确认来源可信再启用；如需更稳妥，优先使用不带远程校验的普通音源。',
    pattern: /SERVER_SCRIPT_CONFIG|signSalt|fingerprint|apiKey/
  },
  {
    id: 'self-defending-obfuscation',
    severity: 'warn',
    title: '疑似自我保护型混淆',
    detail: (_m, script) => {
      const exotic = (
        script.match(/[\u200B-\u200F\uFE00-\uFE0F\u0600-\u06FF\uFE70-\uFEFF]/g) ?? []
      ).length
      return `发现 ${exotic} 个零宽/异体字符标识符，属于反调试混淆特征。代码无法被人工审阅。`
    },
    remedy: '源码不可读意味着无法确认它做什么。只在完全信任来源时启用。',
    pattern: /[\u200B-\u200F\uFE00-\uFE0F\u0600-\u06FF\uFE70-\uFEFF]{50,}/
  },
  {
    id: 'dynamic-code',
    severity: 'warn',
    title: '使用动态代码执行',
    detail: () => '脚本使用 eval / new Function / Function 构造器执行代码，隐藏了真实行为。',
    remedy: '混淆是常见做法，但会让你无法审查。搭配「高风险」评级时尤其谨慎。',
    pattern: /\beval\s*\(|new\s+Function\s*\(|Function\s*\(\s*['"]/
  },
  {
    id: 'infinite-loop',
    severity: 'warn',
    title: '包含无退出条件的循环',
    detail: () => '发现 while(true) 或 for(;;) 形式的循环，可能导致进程卡死。',
    remedy: '卡死已被进程隔离与超时兜住，但脚本可能因此不可用。',
    pattern: /while\s*\(\s*(?:true|1|!!\[\])\s*\)|for\s*\(\s*;\s*;\s*\)/
  },
  {
    id: 'memory-pressure',
    severity: 'warn',
    title: '存在大额内存分配',
    detail: () => '发现超大数组或缓冲区分配，可能触发内存上限。',
    remedy: '进程有 512 MB 上限，超限只会杀掉该音源进程，但会导致它不可用。',
    pattern: /new\s+Array\s*\(\s*\d{7,}|new\s+ArrayBuffer\s*\(\s*\d{8,}|Buffer\.alloc\s*\(\s*\d{8,}/
  }
]

/**
 * Validate a script before it is allowed to start.
 *
 * Pure: takes the decoded source text, returns a report. No side effects, no
 * execution, no filesystem access.
 */
export function validateSourceBeforeStart(
  script: string,
  options: { name?: string } = {}
): ValidationReport {
  const findings: ValidationFinding[] = []

  for (const check of SYSTEM_LEVEL_CHECKS) {
    const match = check.pattern.exec(script)
    if (!match) continue
    findings.push({
      id: check.id,
      severity: check.severity,
      title: check.title,
      detail: `匹配到：${truncate(match[0], 120)}`,
      remedy: check.remedy
    })
  }

  for (const check of RISK_CHECKS) {
    const match = check.pattern.exec(script)
    if (!match) continue
    findings.push({
      id: check.id,
      severity: check.severity,
      title: check.title,
      detail: check.detail(match, script),
      remedy: check.remedy
    })
  }

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))

  // A single enormous line with almost no line breaks is an obfuscator packer:
  // static reading stops being meaningful, and saying so is more useful than
  // implying the clean result means something.
  const lines = script.split('\n')
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const readable = !(longest > 20_000 || (lines.length < 30 && script.length > 20_000))

  if (!readable) {
    findings.push({
      id: 'unreadable',
      severity: 'info',
      title: '脚本主体经过打包压缩',
      detail:
        '代码被压成极少数超长行，下面的检查只能覆盖外层可见部分；' +
        '被加密的字符串在运行时才会解开，静态校验看不到它们。',
      remedy: '校验通过不等于绝对安全。请只使用可信来源的音源。'
    })
  }

  /**
   * ## Combined-trait rule: unreadable + remotely authorised
   *
   * Individual traits are weak signals, so they stay warnings. The *combination*
   * is not weak — it is the exact fingerprint of the one source observed
   * shutting a user's machine down:
   *
   *   - `SERVER_SCRIPT_CONFIG` carrying an `apiUrl` / `signSalt` / `fingerprint`,
   *     i.e. the script takes orders and validation data from a remote server;
   *   - body packed into a few enormous lines with an encrypted string table,
   *     i.e. its actual behaviour cannot be read before it runs.
   *
   * Neither trait alone justifies a block. Together they describe a script that
   * (a) can be told what to do by someone else and (b) cannot be inspected —
   * which is precisely the shape that cannot be cleared by static analysis, and
   * is therefore the one shape that must not be auto-started on a single click.
   *
   * This landed here after a real miss: the source was allowed through, because
   * the shutdown call lives inside the encrypted string table where no text
   * scan can reach it. The warning was technically correct and practically
   * useless — the user clicked the switch and the machine went down.
   */
  const hasServerAuthorisation = findings.some((f) => f.id === 'server-authorised')
  if (hasServerAuthorisation && !readable) {
    findings.push({
      id: 'uninspectable-remote-control',
      severity: 'block',
      title: '不可审阅 + 远程可控（已知关机型音源的特征）',
      detail:
        '该脚本的行为由远端服务器下发，同时代码被加密压缩、无法在运行前审阅。' +
        '经实测，具备这一组合特征的音源曾导致系统关机；其危险调用藏在运行时才解密的字符串中，' +
        '静态检查无法看到，因此不能放行。',
      remedy:
        '建议删除该音源。若确实需要使用，请先在虚拟机或备用机器上验证，' +
        '不要在存有未保存工作的主力机上启动。'
    })
  }

  // Re-sort: the combined-trait rule above may have appended a `block` after
  // the first sort, and callers rely on the order being most-severe-first.
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))

  const blocked = findings.some((f) => f.severity === 'block')
  const clean = !findings.some((f) => f.severity !== 'info')

  void options
  return { blocked, clean, findings, inspected: { characters: script.length, readable } }
}

function severityRank(severity: FindingSeverity): number {
  return severity === 'block' ? 0 : severity === 'warn' ? 1 : 2
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

/** One-line summary suitable for a toast or a log line. */
export function summariseReport(report: ValidationReport): string {
  const blocks = report.findings.filter((f) => f.severity === 'block')
  if (blocks.length > 0) {
    return `校验未通过：${blocks.map((f) => f.title).join('；')}`
  }
  const warns = report.findings.filter((f) => f.severity === 'warn')
  if (warns.length > 0) {
    return `校验通过（有 ${warns.length} 项提示）：${warns.map((f) => f.title).join('；')}`
  }
  return '校验通过：未发现明显风险特征'
}
