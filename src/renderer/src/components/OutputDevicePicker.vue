<script setup lang="ts">
import { ref } from 'vue'
import type { DlnaDevice } from '@shared/dlna'
import { dlnaFailure } from '@shared/dlna-errors'
import { usePlayerStore } from '../stores/player'
const player=usePlayerStore()
const open=ref(false),busy=ref(false),error=ref('')
const needsStopConfirmation=ref(false)
function showFailure(cause:unknown){const failure=dlnaFailure(cause);error.value=failure.message;needsStopConfirmation.value=failure.requiresStopConfirmation}
const interfaces=ref<Array<{id:string;name:string;address:string}>>([])
const selected=ref(''),devices=ref<DlnaDevice[]>([])
async function show(){open.value=!open.value;if(open.value){try{interfaces.value=await window.jj.dlna.interfaces()}catch(e){showFailure(e)}}}
async function discover(){busy.value=true;error.value='';devices.value=[];needsStopConfirmation.value=false;try{devices.value=await window.jj.dlna.discover(selected.value)}catch(e){showFailure(e)}finally{busy.value=false}}
async function choose(device:DlnaDevice|null,allowUnconfirmed=false){busy.value=true;error.value='';needsStopConfirmation.value=false;try{await player.selectDlnaOutput(device,allowUnconfirmed);open.value=false}catch(e){showFailure(e)}finally{busy.value=false}}
</script>
<template>
  <div class="output-picker">
    <button class="output-trigger" @click="show" :aria-expanded="open">{{player.remoteOutput?.device.name||'本机输出'}}</button>
    <section v-if="open" class="output-panel" aria-label="音乐输出设备">
      <strong>音乐投放</strong>
      <p>同一局域网投放本地及在线 MP3。点击搜索后才发现设备。</p>
      <p>其他编码不自动转码；在线按设备兼容档位解析，保留原曲目身份。</p>
      <select v-model="selected" aria-label="局域网网卡" :disabled="busy"><option value="">选择网卡</option><option v-for="item in interfaces" :key="item.id" :value="item.id">{{item.name}} · {{item.address}}</option></select>
      <button :disabled="busy||!selected||!!player.remoteOutput" @click="discover">{{busy?'处理中…':'搜索设备'}}</button>
      <p v-if="player.remoteOutput">投放期间不重新搜索；需要搜索时先返回本机并保持暂停。</p>
      <button :disabled="busy" @click="choose(null)">返回本机（保持暂停）</button>
      <button v-for="device in devices" :key="device.id" :disabled="busy" @click="choose(device)">{{device.name}} · {{device.address}}</button>
      <p v-if="!devices.length">尚无可用设备。确认网络与设备的投放功能后重试。</p>
      <p v-if="player.remoteOutput">投放不使用本机音效、交叉渐变或频谱；设备兼容与听感尚未实测。</p>
      <p v-if="error" role="alert">{{error}}</p>
      <button v-if="needsStopConfirmation" :disabled="busy" @click="choose(null,true)">设备可能仍在播放；我已确认停止，返回本机（暂停）</button>
    </section>
  </div>
</template>
<style scoped>
.output-picker{position:relative}.output-trigger{border:0;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.output-panel{position:absolute;right:0;bottom:38px;width:310px;padding:18px;background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--divider);border-radius:10px;box-shadow:0 8px 30px #0004;z-index:30;display:grid;gap:10px}.output-panel p{font-size:12px;color:var(--text-secondary);line-height:1.5;margin:0}.output-panel button,.output-panel select{font:inherit;font-size:12px;padding:8px;border:1px solid var(--divider);border-radius:6px;background:var(--bg-panel);color:inherit}.output-panel button{cursor:pointer}.output-panel :disabled{opacity:.5;cursor:default}
</style>
