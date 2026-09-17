/** Minimal toast notifications, used for errors and confirmations. */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'error'
}

let nextId = 1

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])

  function push(message: string, kind: Toast['kind'] = 'info'): void {
    const id = nextId++
    toasts.value.push({ id, message, kind })
    // Errors linger; everything else is transient.
    const ttl = kind === 'error' ? 6000 : 2600
    setTimeout(() => dismiss(id), ttl)
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  return {
    toasts,
    push,
    dismiss,
    info: (message: string) => push(message, 'info'),
    success: (message: string) => push(message, 'success'),
    error: (message: string) => push(message, 'error')
  }
})
