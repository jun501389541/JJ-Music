export type UpdatePhase = 'unavailable' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error'

/** Public UI state. Paths, arbitrary URLs, signatures and raw updater errors stay in main. */
export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  version?: string
  notes?: string
  size?: number
  progress?: number
  message?: string
  releaseUrl?: string
}
