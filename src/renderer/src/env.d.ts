/// <reference types="vite/client" />

import type { JjApi } from '../../preload'

declare global {
  const __APP_VERSION__: string
  interface Window {
    /** The narrow, context-isolated bridge exposed by the preload script. */
    jj: JjApi
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

export {}
