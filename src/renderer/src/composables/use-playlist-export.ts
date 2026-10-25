import {ref} from 'vue'
import {useUiStore} from '../stores/ui'
import {useToastStore} from '../stores/toast'
/** Both entry points export stored playlists, never a renderer-filtered subset. */
export function usePlaylistExport(){
 const exporting=ref(false),ui=useUiStore(),toast=useToastStore()
 async function exportPlaylists(id?:string,name?:string):Promise<void>{
  if(exporting.value)return
  exporting.value=true
  try{
   if(!await ui.confirm(id?'导出完整歌单信息':'备份全部歌单信息',`${id?`导出“${name??'当前歌单'}”的全部曲目`:'导出全部已保存歌单（包括收藏和默认列表）'}，不受当前筛选影响。文件只含歌单、曲目和来源标识，不含音频、封面/歌词文件、音源脚本或播放器设置。`))return
   const result=await window.jj.playlists.exportJson(id)
   if(result)toast.success(`已导出 ${result.playlists} 个歌单、${result.tracks} 首曲目信息`)
  }catch(error){toast.error(error instanceof Error?error.message:'导出失败')}
  finally{exporting.value=false}
 }
 return{exporting,exportPlaylists}
}
