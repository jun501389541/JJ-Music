import { resolve } from 'node:path'
import { readFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * Copy the main process's committed PNG assets next to the built entry point.
 *
 * The tray and taskbar icons are read at runtime with a path relative to
 * `out/main`, and rollup does not emit non-imported files, so they have to be
 * carried over explicitly. `build/` (electron-builder's buildResources) is
 * deliberately not shipped, which is why these live under `src/main/assets`.
 */
function copyMainAssets() {
  return {
    name: 'copy-main-assets',
    closeBundle(): void {
      const from = resolve('src/main/assets')
      const to = resolve('out/main/assets')
      try {
        mkdirSync(to, { recursive: true })
        for (const file of readdirSync(from)) {
          if (file.endsWith('.png')) copyFileSync(resolve(from, file), resolve(to, file))
        }
      } catch {
        // No assets directory is not fatal: the icon helpers degrade to an
        // empty image rather than failing the build.
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMainAssets()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // 音源 scripts run in a forked child process, so the host entry must
          // be emitted as its own loadable file — `fork()` takes a path, not a
          // module reference.
          'source-host': resolve('src/main/sources/source-host.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: {
          // A sandboxed preload must be CommonJS: Electron loads it with
          // `require`, so an ESM bundle fails with "Cannot use import statement
          // outside a module". The `.cjs` extension is required because the
          // package itself is `"type": "module"`.
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL('./package.json', import.meta.url),'utf8')).version) },
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [vue()]
  }
})
