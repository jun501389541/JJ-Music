import type { OnlineMusicInfo, SourceId, SourceInfo, PlatformProbeResult } from '@shared/types'

/** Probe a sample through this platform only: no cross-platform playback fallback. */
export async function probePlatform(source: SourceInfo, deps: {
  search: (id: SourceId) => Promise<OnlineMusicInfo[]>
  resolve: (track: OnlineMusicInfo) => Promise<string>
  fetch: typeof fetch
}, timeoutMs = 20000): Promise<PlatformProbeResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let sample: string | undefined
  const result = (status: PlatformProbeResult['status'], message: string): PlatformProbeResult => ({ status, message, checkedAt: Date.now(), ...(sample ? {sample} : {}) })
  try {
    return await Promise.race([
      new Promise<PlatformProbeResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(result('unknown', '验证超时，请稍后重试')) }, timeoutMs) }),
      (async () => {
        if (!source.actions.includes('musicUrl')) return result('unknown', '此平台未声明播放地址能力')
        let tracks: OnlineMusicInfo[]
        try { tracks = await deps.search(source.id) } catch { return result('unknown', '无法取得该平台的测试歌曲，不能据此判断音源失效') }
        if (controller.signal.aborted) return result('unknown', '验证已超时')
        if (!tracks.length) return result('unknown', '没有找到测试歌曲')
        // Try two recordings to avoid treating a single unavailable song as a dead platform.
        let reason = '未取得可用音频'
        for (const track of tracks.slice(0, 2)) {
          if (controller.signal.aborted) break
          sample = `${track.name} · ${track.singer}`
          try {
            const url = await deps.resolve(track)
            if (controller.signal.aborted) break
            const response = await deps.fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: controller.signal })
            try {
              if (!response.ok) { reason = `音频地址返回 HTTP ${response.status}`; continue }
              const reader = response.body?.getReader()
              if (!reader) { reason = '音频响应为空'; continue }
              const { value } = await reader.read()
              await reader.cancel().catch(() => undefined)
              if (!value?.length) { reason = '音频响应为空'; continue }
              const prefix = new TextDecoder().decode(value.slice(0, 32)).trimStart()
              if (/^(?:<|\{|\[)/.test(prefix)) { reason = '地址返回了错误页面或 JSON，而非音频'; continue }
              const signature = /^(ID3|fLaC|OggS|RIFF)/.test(prefix) || (value[0] === 0xff && (value[1] & 0xe0) === 0xe0) || new TextDecoder().decode(value.slice(4, 8)) === 'ftyp'
              if (signature) return result('available', '已解析播放地址并读取到音频数据；仅代表本次样本，不保证所有歌曲可播')
              return result('unknown', '地址可访问，但未识别音频格式，需实际播放确认')
            } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined) }
          } catch (error) { reason = error instanceof Error ? error.message : String(error) }
        }
        return result('failed', `测试歌曲未通过：${reason}`)
      })()
    ])
  } finally { clearTimeout(timer); controller.abort() }
}
