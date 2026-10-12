import type { OnlineMusicInfo } from '@shared/types'

const normalize = (text: string): string => typeof text === 'string' ? text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '') : ''
const versions = [/\blive\b|现场|演唱会/i, /instrumental|伴奏|纯音乐/i, /\bcover\b|翻唱/i, /remix|混音/i, /\bdemo\b|小样/i, /acoustic|不插电/i, /remaster|重制/i, /re[ -]?record|重新录制|重录版|重录制/i, /taylor.?s version/i, /特别版|特別版|special edition|deluxe|豪华版/i, /日语|日文|japanese/i, /韩语|韩文|korean/i, /英语版|英文版|english version/i, /国语版|普通话版|mandarin/i, /粤语版|cantonese/i]

function artists(text: string): string[] {
  if (typeof text !== 'string') return []
  return [...new Set(text.normalize('NFKC').toLowerCase().split(/[、,;/，；]|\s+(?:&|and|feat\.?|ft\.?)\s+/i).map(normalize).filter(Boolean))].sort()
}
function duration(text?: string): number | undefined {
  if (!text || !/^\d+:\d{2}$/.test(text)) return undefined
  const [minutes, seconds] = text.split(':').map(Number)
  return seconds < 60 && minutes * 60 + seconds > 0 ? minutes * 60 + seconds : undefined
}

/** Conservative equality, not a claim that matching tags identify a master. */
export function matchRecording(original: OnlineMusicInfo, candidate: OnlineMusicInfo): boolean {
  if (!normalize(original.name) || normalize(original.name) !== normalize(candidate.name)) return false
  const left = artists(original.singer), right = artists(candidate.singer)
  if (!left.length || left.length !== right.length || left.some((name, i) => name !== right[i])) return false
  const versionText = (track: OnlineMusicInfo): string => `${track.name} ${track.albumName ?? ''}`
  if (versions.some(pattern => pattern.test(versionText(original)) !== pattern.test(versionText(candidate)))) return false
  if (versions.some(pattern => pattern.test(versionText(original)))) {
    const years = (track: OnlineMusicInfo): string => [...new Set(versionText(track).match(/\b(?:19|20)\d{2}\b/g) ?? [])].sort().join(',')
    if (years(original) !== years(candidate)) return false
  }
  const a = duration(original.interval), b = duration(candidate.interval)
  return a !== undefined && b !== undefined && Math.abs(a - b) <= 5
}

export function recordingCandidates(original: OnlineMusicInfo, found: OnlineMusicInfo[]): OnlineMusicInfo[] {
  const seen = new Set<string>()
  return found.slice(0, 20).filter(candidate => {
    const key = `${candidate.source}:${candidate.id}`
    if (seen.has(key) || !matchRecording(original, candidate)) return false
    seen.add(key)
    return true
  }).sort((a, b) => {
    const agrees = (candidate: OnlineMusicInfo): number => original.albumName && candidate.albumName && normalize(original.albumName) === normalize(candidate.albumName) ? 1 : 0
    return agrees(b) - agrees(a) || Math.abs(duration(a.interval)! - duration(original.interval)!) - Math.abs(duration(b.interval)! - duration(original.interval)!)
  }).slice(0, 3)
}
