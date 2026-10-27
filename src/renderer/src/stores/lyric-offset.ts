import {defineStore} from 'pinia'
import {ref,shallowRef} from 'vue'
import {assertLyricOffsetMs,validateLyricOffsetKey,validateLyricOffsetMap,type LyricOffsetMap} from '@shared/lyric-offset'
import {useToastStore} from './toast'
export const useLyricOffsetStore=defineStore('lyric-offset',()=>{
 const status=ref<'idle'|'loading'|'ready'|'error'>('idle'),busy=ref(false),error=ref('')
 const offsets=shallowRef<Readonly<LyricOffsetMap>>(Object.freeze({}))
 let loading:Promise<void>|undefined
 function initialize():Promise<void>{
  if(!loading){status.value='loading';loading=(async()=>{
   try{offsets.value=Object.freeze(validateLyricOffsetMap(await window.jj.lyricOffsets.get()));status.value='ready'}
   catch(cause){error.value=cause instanceof Error?cause.message:String(cause);status.value='error';useToastStore().error('歌词校准记录读取失败，暂未使用已存校准')}
  })()}
  return loading
 }
 async function set(key:string,offsetMs:number):Promise<void>{
  if(status.value!=='ready')throw Error('歌词校准记录尚不可用')
  if(busy.value)throw Error('歌词校准正在保存，请稍后再试')
  validateLyricOffsetKey(key);assertLyricOffsetMs(offsetMs);busy.value=true
  try{
   const result=await window.jj.lyricOffsets.set(key,offsetMs)
   if(!result||result.key!==key||result.offsetMs!==offsetMs)throw Error('歌词校准保存应答无效')
   const next={...offsets.value};if(offsetMs===0)delete next[key];else next[key]=offsetMs
   offsets.value=Object.freeze(next)
  }finally{busy.value=false}
 }
 async function refresh():Promise<void>{offsets.value=Object.freeze(validateLyricOffsetMap(await window.jj.lyricOffsets.get()))}
 return{status,busy,error,offsets,initialize,set,refresh}
})
