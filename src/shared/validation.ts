/**
 * Shared types for 音源 pre-flight validation.
 *
 * These live in `shared` rather than beside the validator because the renderer
 * and the preload bridge both need them, and neither should have to import from
 * `src/main` to describe an IPC payload. The validator in `src/main` implements
 * against these types; nothing here has behaviour.
 */

/** How serious a validation finding is. `block` refuses the start. */
export type FindingSeverity = 'block' | 'warn' | 'info'

export interface ValidationFinding {
  /** Stable id, so the UI can group and tests can assert precisely. */
  id: string
  severity: FindingSeverity
  /** Short headline. */
  title: string
  /** What was observed, including the matched text where useful. */
  detail: string
  /** What the user can do about it. */
  remedy: string
}

export interface ValidationReport {
  /** True when at least one `block` finding is present. */
  blocked: boolean
  /** True when nothing more serious than `info` was found. */
  clean: boolean
  /** Findings, most severe first. */
  findings: ValidationFinding[]
  /** What the check was able to look at — stated so the guarantee is not overstated. */
  inspected: {
    characters: number
    /**
     * False when obfuscation makes static reading meaningless. A clean report
     * on an unreadable script means "we could not see anything wrong", not
     * "this is safe".
     */
    readable: boolean
  }
}

/** Result of an enable attempt, so the UI can explain a refusal. */
export interface SourceToggleResult {
  started: boolean
  report: ValidationReport | null
}
