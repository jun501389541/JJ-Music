<script setup lang="ts">
import {onMounted,ref} from 'vue'
import {formatBookmarkTime,parseBookmarkTime,type Bookmark} from '@shared/track-bookmarks'
import {useTrackBookmarksStore} from '../stores/track-bookmarks'
const props=defineProps<{trackKey:string;expected:Bookmark;trackName:string;platform:string;locked?:boolean;unverified?:boolean;validate?:(positionMs:number)=>void}>(),emit=defineEmits<{done:[];cancel:[]}>()
const store=useTrackBookmarksStore(),text=ref(formatBookmarkTime(props.expected.positionMs)),problem=ref(''),input=ref<HTMLInputElement|null>(null)
onMounted(()=>{input.value?.focus();input.value?.select()})
async function save():Promise<void>{
 if(props.locked||store.busy)return;problem.value=''
 try{const positionMs=parseBookmarkTime(text.value);props.validate?.(positionMs);await store.mutate({kind:'move',key:props.trackKey,expected:props.expected,positionMs});emit('done')}
 catch(e){problem.value=String(e instanceof Error?e.message:e)}
}
</script>
<template>
 <form class="bookmark-time-editor" aria-label="修改书签时间" @submit.prevent="save">
  <p>{{trackName}} · {{platform}} · {{expected.name}} · 原时间 {{formatBookmarkTime(expected.positionMs)}}</p>
  <label>新时间 <input ref="input" v-model="text" class="input" aria-label="书签新时间" maxlength="40" :disabled="locked||store.busy" placeholder="01:23.4" /></label>
  <p>支持秒、分:秒或时:分:秒，最多1位小数。保存只修改书签，不跳转播放。</p>
  <p v-if="unverified">尚未验证实际时长，播放前仍会校验。</p>
  <p v-if="problem" role="alert">{{problem}}</p>
  <div class="actions"><button type="submit" class="btn" :disabled="locked||store.busy">保存时间</button><button type="button" class="btn" :disabled="store.busy" @click="emit('cancel')">取消修改时间</button></div>
 </form>
</template>
<style scoped>
.bookmark-time-editor{padding:16px;border:1px solid var(--border-subtle);border-radius:6px;width:100%;box-sizing:border-box}.bookmark-time-editor p{font-size:12px;color:var(--text-secondary);line-height:1.6;overflow-wrap:anywhere}.input{margin:8px;max-width:240px}.actions{display:flex;gap:10px;flex-wrap:wrap}[role=alert]{color:var(--danger,#f66)}input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
