import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
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
  const playbackPanel = ref<'eq' | 'queue' | null>(null)
  const menu = shallowRef<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const trackInfo = shallowRef<PlayableTrack | null>(null)
  const matchTrack = shallowRef<LocalMusicInfo | null>(null)
  const dialog = shallowRef<{ title: string; message?: string; value?: string; confirmLabel?: string; resolve: (value: string | null) => void } | null>(null)
  function openMenu(event: MouseEvent, items: MenuItem[]): void {
    event.preventDefault(); event.stopPropagation()
    menu.value = { x: event.clientX, y: event.clientY, items }
  }
  function prompt(title: string, value = ''): Promise<string | null> {
    dialog.value?.resolve(null)
    return new Promise(resolve => { dialog.value = { title, value, resolve } })
  }
  function confirm(title: string, message: string): Promise<string | null> {
    dialog.value?.resolve(null)
    return new Promise(resolve => { dialog.value = { title, message, confirmLabel: '确认', resolve } })
  }
  function finishDialog(value: string | null): void { dialog.value?.resolve(value); dialog.value = null }
  return { nowPlaying, playbackPanel, menu, trackInfo, matchTrack, dialog, openMenu, prompt, confirm, finishDialog }
})
