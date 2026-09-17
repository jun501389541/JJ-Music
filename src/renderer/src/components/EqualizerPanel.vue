<script setup lang="ts">
import { EQUALIZER_BANDS, EQUALIZER_PRESETS } from '@shared/audio-engine'
import { usePlayerStore } from '../stores/player'
const player = usePlayerStore()
function change(index: number, event: Event): void {
  const gains = [...player.equalizer]
  gains[index] = Number((event.target as HTMLInputElement).value)
  player.setEqualizer(gains, '自定义')
}
</script>
<template>
  <section class="equalizer-content" aria-label="均衡器">
    <p>10 段均衡器 · {{ player.equalizerPreset }}</p>
    <div class="eq-presets"><button v-for="(_, name) in EQUALIZER_PRESETS" :key="name" class="btn" :class="{ 'btn--primary': player.equalizerPreset === name }" @click="player.applyEqualizerPreset(String(name))">{{ name }}</button></div>
    <div class="eq-bands"><label v-for="(band, index) in EQUALIZER_BANDS" :key="band"><output>{{ player.equalizer[index] }}</output><input type="range" min="-12" max="12" step="1" :value="player.equalizer[index]" :aria-label="`${band} Hz 增益`" @input="change(index, $event)"/><span>{{ band >= 1000 ? band / 1000 + 'k' : band }}</span></label></div>
    <p class="eq-note">频率 / Hz · 增益 / dB<br>调整即时生效并自动保存。增益过高时可降低音量。</p>
  </section>
</template>
<style scoped>
.equalizer-content>p{color:var(--text-secondary);font-size:12px;line-height:1.8;margin:0 0 22px}.eq-presets{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:30px}.eq-presets .btn{font-size:12px;padding:0 12px}.eq-bands{display:flex;justify-content:space-between;gap:7px;padding:25px 10px;background:#ffffff05;border:1px solid var(--border-subtle);border-radius:8px}.eq-bands label{display:flex;flex-direction:column;align-items:center;gap:18px;min-width:0;flex:1}.eq-bands input{writing-mode:vertical-lr;direction:rtl;width:20px;height:180px;accent-color:var(--accent)}.eq-bands output{font-size:12px}.eq-bands span{font-size:10px;color:var(--text-secondary)}.equalizer-content .eq-note{margin-top:24px;font-size:11px}
@media(max-height:700px){.eq-bands input{height:135px}.eq-presets{margin-bottom:18px}}
</style>
