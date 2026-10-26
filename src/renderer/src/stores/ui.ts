import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type {LoopEditContext} from '@shared/loop-time'
import type { RelinkReference } from '@shared/batch-file-relink'
import type { LocalMusicInfo, PlayableTrack } from '@shared/types'

export interface MenuItem {
  label: string
  icon?: string
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  children?: MenuItem[]
  action?: () => unknown | Promise<unknown>
}
export const useUiStore = defineStore('ui', () => {
  const nowPlaying = ref(false)
  const batchRelinkTargets = shallowRef<RelinkReference[]>([])
  const localRelinkBatch = ref<{completed:number;total:number;stopRequested:boolean}|null>(null)
  const localRelinkBusy = ref(false)
  const playbackPanel = ref<'eq' | 'queue' | null>(null)
  const loopRangeEdit=shallowRef<LoopEditContext|null>(null)
  const menu = shallowRef<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const trackInfo = shallowRef<PlayableTrack | null>(null)
  const matchTrack = shallowRef<LocalMusicInfo | null>(null)
  const dialog = shallowRef<{ title: string; message?: string; value?: string; maxLength?:number; confirmLabel?: string; resolve: (value: string | null) => void } | null>(null)
  function openMenu(event: MouseEvent, items: MenuItem[]): void {
    event.preventDefault(); event.stopPropagation()
    menu.value = { x: event.clientX, y: event.clientY, items }
  }
  function prompt(title: string, value = '', message?:string, maxLength=100): Promise<string | null> {
    dialog.value?.resolve(null)
    return new Promise(resolve => { dialog.value = { title, value, message, maxLength, resolve } })
  }
  function confirm(title: string, message: string): Promise<string | null> {
    dialog.value?.resolve(null)
    return new Promise(resolve => { dialog.value = { title, message, confirmLabel: '确认', resolve } })
  }
  function finishDialog(value: string | null): void { dialog.value?.resolve(value); dialog.value = null }
  return { loopRangeEdit,localRelinkBatch, batchRelinkTargets, localRelinkBusy, nowPlaying, playbackPanel, menu, trackInfo, matchTrack, dialog, openMenu, prompt, confirm, finishDialog }
})
