export const PLAYBACK_DATA_MAX_BYTES=64*1024*1024
export const PLAYBACK_DATA_CATEGORIES=['offsets','resume','bookmarks','statistics'] as const
export type PlaybackDataCategory=typeof PLAYBACK_DATA_CATEGORIES[number]
export type PlaybackDataCounts=Record<PlaybackDataCategory,{add:number;keep:number}>
export interface PlaybackDataPreview {token:string;fileName:string;createdAt:string;counts:PlaybackDataCounts}
export interface PlaybackDataResult {completed:PlaybackDataCategory[];added:Partial<Record<PlaybackDataCategory,number>>;error?:string}
