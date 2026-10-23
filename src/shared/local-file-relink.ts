import { isLocalTrack, type AppSettings, type LocalMusicInfo, type PlayableTrack } from './types'

export interface LocalRelinkChange { old: LocalMusicInfo; next: LocalMusicInfo }
export interface LocalRelinkPreview extends LocalRelinkChange { token: string }
export function sameLocalPath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()
}
export function relinkTrack<T extends PlayableTrack>(track: T, change: LocalRelinkChange): T {
  return isLocalTrack(track) && track.id === change.old.id && sameLocalPath(track.path, change.old.path)
    ? structuredClone(change.next) as T : track
}
export function relinkSettings<T extends Partial<AppSettings>>(settings: T, change: LocalRelinkChange): T {
  return {
    ...settings,
    ...(settings.recentPlayed ? { recentPlayed: settings.recentPlayed.map(t => relinkTrack(t, change)) } : {}),
    ...(settings.lastSession ? { lastSession: { ...settings.lastSession, track: relinkTrack(settings.lastSession.track, change), queue: settings.lastSession.queue.map(t => relinkTrack(t, change)) } } : {}),
    ...(settings.queueHistory ? { queueHistory: settings.queueHistory.map(q => ({ ...q, queue: q.queue.map(t => relinkTrack(t, change)) })) } : {})
  }
}
