<script setup lang="ts">
import {nextTick,ref,watch} from 'vue'
import {formatLoopTime,parseLoopTime,type LoopEditContext} from '@shared/loop-time'
import {usePlayerStore} from '../stores/player'
const props=defineProps<{context:LoopEditContext}>(),emit=defineEmits<{close:[]}>(),player=usePlayerStore()
const a=ref(''),b=ref(''),error=ref(''),first=ref<HTMLInputElement|null>(null)
watch(()=>props.context,async context=>{a.value=formatLoopTime(context.a);b.value=formatLoopTime(context.b);error.value='';await nextTick();first.value?.focus();first.value?.select()},{immediate:true})
function submit():void{
 try{player.applyLoopRange(props.context,parseLoopTime(a.value),parseLoopTime(b.value));emit('close')}
 catch(cause){error.value=cause instanceof Error?cause.message:'无法设置片段循环'}
}
function trap(event:KeyboardEvent):void{
 if(event.key!=='Tab')return
 const items=[...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('input,button')],head=items[0],tail=items.at(-1)
 if(event.shiftKey&&document.activeElement===head){event.preventDefault();tail?.focus()}
 else if(!event.shiftKey&&document.activeElement===tail){event.preventDefault();head?.focus()}
}
</script>
<template><Teleport to="body"><div class="loop-dialog-backdrop" @mousedown.self="emit('close')" @keydown.esc.stop.prevent="emit('close')" @keydown="trap">
 <form class="loop-dialog" role="dialog" aria-modal="true" aria-label="输入 A/B 时间" @submit.prevent="submit">
  <h2>输入 A/B 时间</h2><p>{{context.name}} · 曲长 {{formatLoopTime(context.duration)}}</p>
  <label>A 点<input ref="first" v-model="a" class="input" aria-label="A 点时间" maxlength="40" required placeholder="0:00" /></label>
  <label>B 点<input v-model="b" class="input" aria-label="B 点时间" maxlength="40" required placeholder="1:30.500" /></label>
  <p>支持秒数、分:秒、时:分:秒，小数最多3位。片段至少1秒；确认后启用循环，暂停时不会自动播放。</p>
  <p v-if="error" role="alert" class="loop-error">{{error}}</p>
  <footer><button type="button" class="btn" @click="emit('close')">取消</button><button type="submit" class="btn btn--primary">启用片段循环</button></footer>
 </form>
</div></Teleport></template>
<style scoped>
.loop-dialog-backdrop{position:fixed;inset:0;z-index:1800;display:grid;place-items:center;background:#0007;backdrop-filter:blur(5px)}.loop-dialog{width:min(500px,85vw);padding:28px;background:var(--bg-panel);border:1px solid var(--border-strong);border-radius:16px;box-shadow:var(--shadow-lg)}h2{font-size:22px;margin:0 0 18px}p{font-size:13px;color:var(--text-secondary);line-height:1.7}label{display:block;margin:14px 0}input{display:block;width:100%;margin-top:6px}footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.loop-error{color:var(--danger,#f66)}
</style>
