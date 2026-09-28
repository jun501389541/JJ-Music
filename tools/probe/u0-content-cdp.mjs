import { writeFileSync } from 'node:fs'

const output = process.argv[2] ?? 'C:\\u0-output\\content-ui.json'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function evaluate(expression) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const tabs = await fetch('http://127.0.0.1:37921/json/list').then(res => res.json())
      const page = tabs.find(tab => tab.type === 'page' && tab.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true })
          ws.addEventListener('error', reject, { once: true })
        })
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('CDP evaluation timed out')), 15000)
          ws.addEventListener('message', event => {
            const message = JSON.parse(event.data)
            if (message.id !== 1) return
            clearTimeout(timer)
            if (message.error || message.result?.exceptionDetails) {
              reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
            } else {
              resolve(message.result.result.value)
            }
          })
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
            expression, awaitPromise: true, returnByValue: true
          } }))
        })
        ws.close()
        return result
      }
    } catch (error) {
      if (Date.now() + 300 >= deadline) throw error
    }
    await sleep(300)
  }
  throw new Error('Application page did not appear on CDP')
}

try {
  const result = await evaluate(`(async () => {
    const api = window.jj
    if (!api) throw new Error('window.jj bridge missing')
    const [location, settings, playlists, tracks, sources] = await Promise.all([
      api.data.location(), api.settings.get(), api.playlists.list(),
      api.library.tracks(), api.sources.list()
    ])
    const playlist = playlists.find(p => p.id === 'u0-fixture-list')
    const items = playlist ? await api.playlists.items(playlist.id) : []
    const track = tracks.find(t => t.id === 'u0-fixture-track')
    const source = sources.find(s => s.id === 'u0-fixture-source')
    return {
      dataDir: location.dir, dataSource: location.source,
      theme: settings.theme, volume: settings.volume,
      playlist: playlist && { name: playlist.name, trackCount: playlist.trackCount },
      playlistItem: items.find(t => t.id === 'u0-fixture-track')?.name ?? null,
      libraryTrack: track && { name: track.name, path: track.path },
      source: source && { name: source.name, enabled: source.enabled }
    }
  })()`)
  writeFileSync(output, JSON.stringify({ ok: true, result }, null, 2))
} catch (error) {
  writeFileSync(output, JSON.stringify({ ok: false, error: String(error) }, null, 2))
  process.exitCode = 1
}
