import type { UpdateCheckResult } from '@shared/types'

/** Per-source update results and request generations for the Sources view. */
export function createSourceUpdateState<T = UpdateCheckResult>() {
  const generations = new Map<string, number>()
  return {
    checking: new Set<string>(),
    results: new Map<string, T>(),

    begin(sourceId: string): number {
      const generation = (generations.get(sourceId) ?? 0) + 1
      generations.set(sourceId, generation)
      this.checking.add(sourceId)
      this.results.delete(sourceId)
      return generation
    },

    complete(sourceId: string, generation: number, result: T): boolean {
      if (generations.get(sourceId) !== generation) return false
      this.checking.delete(sourceId)
      this.results.set(sourceId, result)
      return true
    },

    invalidate(sourceId: string): void {
      generations.set(sourceId, (generations.get(sourceId) ?? 0) + 1)
      this.checking.delete(sourceId)
      this.results.delete(sourceId)
    }
  }
}
