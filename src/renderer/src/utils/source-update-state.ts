import type { SourceApplyResult, UpdateCheckResult } from '@shared/types'
export function sourceUpdateFeedback(result:Pick<SourceApplyResult,'verification'>):string{
  const state=result.verification?.initialization
  return `已安装，${state==='passed'?'初始化通过':state==='notRun'?'保持停用，未运行初始化':'初始化未确认'}；实际播放未验证`
}

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
