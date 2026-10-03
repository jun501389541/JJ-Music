import type { ReleasePayload } from './service'

const REPO = 'jun501389541/JJ-Music'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES = `https://github.com/${REPO}/releases/download`
const ASSET_NAMES = ['update-manifest.json', 'update-manifest.sig', 'latest.yml'] as const

async function bounded(url: string, maxBytes: number, accept = 'application/octet-stream'): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'User-Agent': 'JJ-Music-Updater', Accept: accept }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok || !response.body) throw new Error('无法读取官方更新文件')
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) throw new Error('官方更新文件过大')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      await response.body.cancel().catch(() => {})
      throw new Error('官方更新文件过大')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

export async function loadOfficialRelease(): Promise<ReleasePayload> {
  const release = JSON.parse((await bounded(API, 64_000, 'application/vnd.github+json')).toString('utf8')) as Record<string, unknown>
  const tag = release.tag_name
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) ||
      release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('官方 Release 不是稳定版')
  }
  const setupName = `JJ-Music-${tag.slice(1)}-Setup-x64.exe`
  const expected = [...ASSET_NAMES, setupName]
  const assets = release.assets as Array<Record<string, unknown>>
  for (const name of expected) {
    const matches = assets.filter(asset => asset.name === name && asset.state === 'uploaded')
    if (matches.length !== 1 || matches[0]?.browser_download_url !== `${RELEASES}/${tag}/${name}`) {
      throw new Error('官方 Release 资产不完整')
    }
  }
  const setup = assets.find(asset => asset.name === setupName)!
  if (typeof setup.size !== 'number' || !Number.isSafeInteger(setup.size) || setup.size <= 0) {
    throw new Error('官方安装包大小无效')
  }
  const [bytes, signature, latest] = await Promise.all([
    bounded(`${RELEASES}/${tag}/update-manifest.json`, 16_384),
    bounded(`${RELEASES}/${tag}/update-manifest.sig`, 512),
    bounded(`${RELEASES}/${tag}/latest.yml`, 32_768)
  ])
  return {
    bytes, signature: signature.toString('utf8').trim(), latest: latest.toString('utf8'),
    tag, assetName: setupName, assetSize: setup.size,
    notes: typeof release.body === 'string' ? release.body.slice(0, 1_000).trim() : ''
  }
}
