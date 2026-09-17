/**
 * Parser for the metadata header block at the top of a 音源 script.
 *
 * Scripts begin with a block comment containing `@key value` lines:
 *
 *   /*!
 *    * @name 六音音源
 *    * @description v1.2.1 如失效请前往 www.sixyin.com 下载最新版本
 *    * @version v1.2.1
 *    * @author 六音
 *    * @homepage www.sixyin.com
 *    * @preserve
 *    *\/
 *
 * Real-world scripts are inconsistent: some use `@repository` instead of
 * `@homepage`, some omit fields entirely, and a few put the block after a
 * `"use strict"` prologue. The parser is therefore forgiving and always
 * returns a usable object.
 */

export interface ScriptHeader {
  name: string
  description: string
  version: string
  author: string
  homepage: string
  /** Any other `@key value` pairs, preserved for display. */
  extra: Record<string, string>
}

const HEADER_KEYS = new Set([
  'name',
  'description',
  'version',
  'author',
  'homepage',
  'repository',
  'repo'
])

/** How far into the file to look for the header block. */
const SEARCH_LIMIT = 8192

export function parseScriptHeader(script: string, fallbackName = '未命名音源'): ScriptHeader {
  const head = script.slice(0, SEARCH_LIMIT)
  const header: ScriptHeader = {
    name: '',
    description: '',
    version: '',
    author: '',
    homepage: '',
    extra: {}
  }

  // Match `@key` followed by the rest of the line, tolerating the leading `*`.
  const re = /^[ \t]*(?:\/\*+!?|\*)?[ \t]*@([A-Za-z][\w-]*)[ \t]*[:：]?[ \t]*(.*)$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(head)) !== null) {
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (!value) continue
    if (!HEADER_KEYS.has(key)) {
      // Keep unknown tags but never let them shadow known ones.
      if (!(key in header.extra)) header.extra[key] = value
      continue
    }
    const target = key === 'repository' || key === 'repo' ? 'homepage' : key
    // First occurrence wins: the real header comes before any nested scripts.
    if (!header[target as keyof Omit<ScriptHeader, 'extra'>]) {
      header[target as keyof Omit<ScriptHeader, 'extra'>] = value
    }
  }

  if (!header.name) {
    header.name = fallbackName
  }
  return header
}

/**
 * A single 音源 file can bundle several scripts (aggregators embed others and
 * `eval` them). We only ever run the outermost script, so the header we report
 * is the outer one — which is what the user sees in LX Music too.
 */
export function describeScript(script: string, fallbackName?: string): ScriptHeader {
  return parseScriptHeader(script, fallbackName)
}

/* ------------------------------------------------------------------ *
 * Risk assessment
 * ------------------------------------------------------------------ */

export type ScriptRisk = 'low' | 'medium' | 'high'

export interface ScriptRiskReport {
  risk: ScriptRisk
  /** Human-readable reasons, shown in the import confirmation. */
  notes: string[]
}

/**
 * Heuristically assess whether a script is likely to misbehave.
 *
 * ## Why this exists
 *
 * A source the user imported killed the app on every launch: it terminated its
 * own process, and because sources load at startup the app became permanently
 * unopenable. Isolation now contains that, but a user still deserves to know
 * *before* importing that a script is opaque and self-protecting rather than
 * ordinary plugin code.
 *
 * These are heuristics, not proof. A `low` rating does not guarantee safety,
 * and `high` does not mean malicious — heavy obfuscation is common in this
 * ecosystem. The signal being reported is "we cannot tell what this does",
 * which is itself worth showing.
 */
export function assessScriptRisk(script: string): ScriptRiskReport {
  const notes: string[] = []
  let risk: ScriptRisk = 'low'

  const raise = (level: ScriptRisk): void => {
    const order: ScriptRisk[] = ['low', 'medium', 'high']
    if (order.indexOf(level) > order.indexOf(risk)) risk = level
  }

  const lines = script.split('\n')
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0)

  // One enormous line is the signature of an obfuscator packer.
  if (longestLine > 20_000) {
    notes.push(`存在超长单行（${longestLine} 字符），代码经过混淆打包`)
    raise('high')
  }

  // Very few lines carrying a great deal of code says the same thing.
  if (lines.length < 30 && script.length > 20_000) {
    notes.push(`仅 ${lines.length} 行却包含 ${script.length} 字符，结构被压缩`)
    raise('high')
  }

  const unicodeEscapes = (script.match(/\\u[0-9a-f]{4}/gi) ?? []).length
  if (unicodeEscapes > 200) {
    notes.push(`${unicodeEscapes} 处 \\uXXXX 转义，标识符被编码`)
    raise('medium')
  }

  /**
   * Zero-width and exotic-script identifiers.
   *
   * `javascript-obfuscator`'s self-defending mode renames identifiers using
   * characters from non-Latin scripts and invisible joiners. Their presence is
   * the strongest available signal that a script resists inspection — the one
   * installed source that killed the app carried roughly 660 of them.
   */
  const exotic = (
    script.match(/[\u200B-\u200F\uFE00-\uFE0F\u0600-\u06FF\uFE70-\uFEFF]/g) ?? []
  ).length
  if (exotic > 50) {
    notes.push(`${exotic} 个零宽/异体字符标识符，符合自我防护混淆特征`)
    raise('high')
  }

  // Constructs that can hang or terminate a process from pure JS.
  if (/while\s*\(\s*(?:true|1|!!\[\])\s*\)/.test(script) || /for\s*\(\s*;[^;]*;\s*\)/.test(script)) {
    notes.push('包含无退出条件的循环')
    raise('medium')
  }
  if (/process\s*\.\s*(?:exit|abort|kill)\s*\(/.test(script)) {
    notes.push('调用 process.exit / abort / kill')
    raise('high')
  }
  if (/debugger/.test(script)) {
    notes.push('包含 debugger 语句（反调试）')
    raise('medium')
  }
  if (/(?<![.\w$])eval\s*\(|new\s+Function\s*\(/.test(script)) {
    notes.push('使用 eval / Function 动态执行代码')
  }
  if (/%[A-Za-z]\w*\s*\(/.test(script)) {
    notes.push('出现 V8 原生语法（% 前缀），非常规脚本')
    raise('high')
  }
  if (script.length > 900_000) {
    notes.push(`脚本体积很大（${script.length} 字符）`)
  }

  if (notes.length === 0) notes.push('未发现明显风险特征')

  return { risk, notes }
}
