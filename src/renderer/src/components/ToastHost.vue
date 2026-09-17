<script setup lang="ts">
import { useToastStore } from '../stores/toast'

const toast = useToastStore()
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="item in toast.toasts" :key="item.id" class="toast" :class="`toast--${item.kind}`">
        <span class="toast__text">{{ item.message }}</span>
        <button class="toast__close" type="button" aria-label="关闭" @click="toast.dismiss(item.id)">
          ✕
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 20px;
  bottom: calc(var(--playbar-height) + 16px);
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 240px;
  max-width: 420px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  box-shadow: var(--shadow-lg);
  color: var(--text-primary);
  pointer-events: auto;
}

.toast--success {
  border-left-color: var(--success);
}

.toast--error {
  border-left-color: var(--danger);
}

.toast__text {
  flex: 1;
  line-height: 1.5;
  word-break: break-word;
}

.toast__close {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
}

.toast__close:hover {
  color: var(--text-primary);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(16px);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
</style>
