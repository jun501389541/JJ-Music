import {ONLINE_SOURCE_IDS,isLocalTrack,type PlayableTrack} from './types'
const platformLabels:Record<string,string>={wy:'网易云音乐',tx:'QQ音乐',kw:'酷我音乐',kg:'酷狗音乐',mg:'咪咕音乐'}
export function lyricOffsetPlatform(track:PlayableTrack):string{return isLocalTrack(track)?'本地':platformLabels[track.source]??track.source}
export const LYRIC_OFFSET_MAX_BYTES=4*1024*1024
export const LYRIC_OFFSET_MAX_ENTRIES=50000
export type LyricOffsetMap=Record<string,number>
export interface LyricOffsetResult {key:string;offsetMs:number}
export function validateLyricOffsetKey(key:unknown):asserts key is string{
 if(typeof key!=='string'||key.length>4096||key.includes('\0'))throw Error('歌词校准歌曲身份无效')
 if(key.startsWith('local:')&&key.length>6)return
 const match=/^online:([^:]+):(.+)$/.exec(key)
 if(!match||!ONLINE_SOURCE_IDS.includes(match[1]))throw Error('歌词校准歌曲身份无效')
}
export function assertLyricOffsetMs(value:unknown):asserts value is number{
 if(typeof value!=='number'||!Number.isInteger(value)||value< -30000||value>30000||value%100!==0)throw Error('歌词偏移须为-30.0到+30.0秒，精度0.1秒')
}
export function parseLyricOffsetSeconds(text:string):number{
 const value=text.trim()
 if(!/^[+-]?\d+(?:\.\d)?$/.test(value))throw Error('请输入十进制秒数，最多1位小数，负数提前、正数延后')
 const ms=Math.round(Number(value)*1000)
 assertLyricOffsetMs(ms);return ms===0?0:ms
}
export function lyricTimeMs(seconds:number,offsetMs:number):number{return seconds*1000-offsetMs}
export function lyricSeekSeconds(lineMs:number,offsetMs:number,duration:number):number{
 const target=Math.max(0,(lineMs+offsetMs)/1000)
 return Number.isFinite(duration)&&duration>0?Math.min(duration,target):target
}
export function validateLyricOffsetMap(raw:unknown):LyricOffsetMap{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('歌词校准记录格式无效')
 const result:LyricOffsetMap=Object.create(null)
 for(const [key,value]of Object.entries(raw)){validateLyricOffsetKey(key);assertLyricOffsetMs(value);if(value!==0)result[key]=value}
 if(Object.keys(result).length>LYRIC_OFFSET_MAX_ENTRIES)throw Error('歌词校准记录超过50000条上限')
 return result
}
