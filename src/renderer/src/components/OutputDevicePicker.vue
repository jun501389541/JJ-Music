<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DlnaDevice } from '@shared/dlna'
import { dlnaFailure } from '@shared/dlna-errors'
import { usePlayerStore } from '../stores/player'
const player=usePlayerStore()
const outputTrigger=ref<HTMLButtonElement|null>(null)
const open=ref(false),discovering=ref(false),choosing=ref(false),error=ref('')
const busy=computed(()=>discovering.value||choosing.value)
const needsStopConfirmation=ref(false)
function showFailure(cause:unknown){const failure=dlnaFailure(cause);error.value=failure.message;needsStopConfirmation.value=failure.requiresStopConfirmation}
const interfaces=ref<Array<{id:string;name:string;address:string}>>([])
const selected=ref(''),devices=ref<DlnaDevice[]>([])
let discoveryVersion=0,interfaceVersion=0
function onPickerKeydown(event:KeyboardEvent){
  if(event.key!=='Escape'||!open.value||event.defaultPrevented||event.isComposing)return
  event.stopPropagation();event.preventDefault()
  open.value=false;interfaceVersion++
  outputTrigger.value?.focus()
}
watch(selected,()=>{
  discoveryVersion++
  devices.value=[]
  discovering.value=false
  if(!needsStopConfirmation.value)error.value=''
},{flush:'sync'})
async function show(){
  open.value=!open.value
  const version=++interfaceVersion
  if(!open.value)return
  if(!needsStopConfirmation.value)error.value=''
  try{
    const available=await window.jj.dlna.interfaces()
    if(version!==interfaceVersion||!open.value)return
    interfaces.value=available
    if(selected.value&&!available.some(item=>item.id===selected.value))selected.value=''
  }catch(e){
    if(version!==interfaceVersion||!open.value)return
    interfaces.value=[];selected.value='';devices.value=[]
    if(!needsStopConfirmation.value)showFailure(e)
  }
}
async function discover(){
  const version=++discoveryVersion,interfaceId=selected.value
  discovering.value=true;error.value='';devices.value=[];needsStopConfirmation.value=false
  try{
    const found=await window.jj.dlna.discover(interfaceId)
    if(version===discoveryVersion)devices.value=found
  }catch(e){
    // Stop uncertainty is a global safety barrier, even for an older search.
    if(version===discoveryVersion||dlnaFailure(e).requiresStopConfirmation)showFailure(e)
  }finally{if(version===discoveryVersion)discovering.value=false}
}
async function choose(device:DlnaDevice|null,allowUnconfirmed=false){
  const version=interfaceVersion
  choosing.value=true;error.value='';needsStopConfirmation.value=false
  try{
    await player.selectDlnaOutput(device,allowUnconfirmed)
    // Completing a switch must not dismiss a panel the user reopened meanwhile.
    if(version===interfaceVersion){open.value=false;interfaceVersion++}
  }catch(e){showFailure(e)}finally{choosing.value=false}
}
</script>
<template>
  <div class="output-picker" @keydown="onPickerKeydown">
    <button ref="outputTrigger" class="output-trigger" @click="show" :aria-expanded="open">{{player.remoteOutput?.device.name||'本机输出'}}</button>
    <section v-if="open" class="output-panel" aria-label="音乐输出设备">
      <strong>音乐投放（实验性）</strong>
      <p>同一局域网投放本地及在线 MP3。点击搜索后才发现设备。</p>
      <p>其他编码不自动转码；在线按设备兼容档位解析，保留原曲目身份。</p>
      <p>切换输出会从曲首重新加载；返回本机后保持暂停。</p>
      <p>真实设备兼容与听感尚未验证。</p>
      <select v-model="selected" aria-label="局域网网卡" :disabled="busy"><option value="">选择网卡</option><option v-for="item in interfaces" :key="item.id" :value="item.id">{{item.name}} · {{item.address}}</option></select>
      <button :disabled="busy||!selected||!!player.remoteOutput" @click="discover">{{busy?'处理中…':'搜索设备'}}</button>
      <p v-if="player.remoteOutput">投放期间不重新搜索；需要搜索时先返回本机并保持暂停。</p>
      <button :disabled="busy" @click="choose(null)">返回本机（保持暂停）</button>
      <button v-for="device in devices" :key="device.id" :disabled="busy" @click="choose(device)">{{device.name}} · {{device.address}}</button>
      <p v-if="!devices.length">尚无可用设备。确认网络与设备的投放功能后重试。</p>
      <p v-if="player.remoteOutput">投放不使用本机音效、交叉渐变或频谱。</p>
      <p v-if="error" role="alert">{{error}}</p>
      <button v-if="needsStopConfirmation" :disabled="busy" @click="choose(null,true)">设备可能仍在播放；我已确认停止，返回本机（暂停）</button>
    </section>
  </div>
</template>
<style scoped>
.output-picker{position:relative}.output-trigger{border:0;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.output-panel{position:absolute;right:0;bottom:38px;width:310px;padding:18px;background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--divider);border-radius:10px;box-shadow:0 8px 30px #0004;z-index:30;display:grid;gap:10px}.output-panel p{font-size:12px;color:var(--text-secondary);line-height:1.5;margin:0}.output-panel button,.output-panel select{font:inherit;font-size:12px;padding:8px;border:1px solid var(--divider);border-radius:6px;background:var(--bg-panel);color:inherit}.output-panel button{cursor:pointer}.output-panel :disabled{opacity:.5;cursor:default}
/* Keep device lists reachable above the player, including the minimum window. */
.output-panel{max-width:calc(100vw - 32px);max-height:calc(100vh - 140px);overflow-y:auto;overscroll-behavior:contain;grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;align-content:start}
.output-panel button,.output-panel select{min-width:0;max-width:100%;overflow-wrap:anywhere}
</style>
