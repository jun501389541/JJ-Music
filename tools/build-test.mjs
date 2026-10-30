/**
 * Build the 音源 engine and its test harness with esbuild.
 *
 * The engine is bundled from the same TypeScript sources the app uses, so the
 * test exercises shipping code rather than a re-implementation. Output goes to
 * `out/test/` where `source-engine.test.mjs` can import it.
 *
 * Usage: node tools/build-test.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSourceLauncher } from './build-source-launcher.mjs'

buildSourceLauncher()

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'out', 'test')

mkdirSync(outDir, { recursive: true })

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  // Node built-ins and installed packages stay external; they resolve normally
  // at runtime from node_modules.
  // `undici` is external for a different reason than the rest: it is not a native
  // or Electron-only module, it is plain JavaScript that *could* be bundled — and
  // bundling it breaks it. undici is CommonJS internally; esbuild rewrites its
  // `require('node:assert')` into a shim that throws
  // `Dynamic require of "node:assert" is not supported` in ESM output. Keeping it
  // external means Node resolves the package normally at runtime, CJS and all.
  external: [
    'electron',
    'iconv-lite',
    'music-metadata',
    'node-id3',
    'yaml',
    'electron-updater',
    'undici'
    ,'saxes'
  ],
  alias: {
    '@shared': join(repoRoot, 'src', 'shared'),
    '@main': join(repoRoot, 'src', 'main')
  }
}

await build({
  ...shared,
  entryPoints: [
    join(repoRoot, 'src', 'main', 'online', 'reliability-policy.ts'),
    join(repoRoot, 'src', 'main', 'online', 'auxiliary-requests.ts'),
    join(repoRoot, 'src', 'main', 'online', 'cache-budget.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-scratch.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'lan-policy.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'lan-http-client.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'session-manager.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'media-lease.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'media-server.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'xml.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'soap.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'discovery.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'device-registry.ts'),
    join(repoRoot, 'src', 'main', 'dlna', 'service.ts'),
    join(repoRoot, 'src', 'main', 'online', 'capability-health.ts'),
    join(repoRoot, 'src', 'main', 'online', 'online-diagnostics.ts'),
    join(repoRoot, 'src', 'main', 'online', 'diagnostic-check.ts'),
    join(repoRoot, 'src', 'main', 'online', 'diagnostic-media.ts'),
    join(repoRoot, 'src', 'main', 'online', 'resource-cache.ts'),
    join(repoRoot, 'src', 'main', 'online', 'playlist-refresh.ts'),
    join(repoRoot, 'src', 'main', 'online', 'online-asset-cache.ts'),
    join(repoRoot, 'src', 'main', 'online', 'cover-byte-store.ts'),
    join(repoRoot, 'src', 'main', 'online', 'catalog-reliability.ts'),
    join(repoRoot, 'src', 'main', 'online', 'platform-charts.ts'),
    join(repoRoot, 'src', 'main', 'online', 'charts-service.ts'),
    join(repoRoot, 'src', 'main', 'online', 'playlist-search.ts'),
    join(repoRoot, 'src', 'main', 'online', 'playlist-search-service.ts'),
    join(repoRoot, 'src', 'main', 'online', 'playlist-previews.ts'),
    join(repoRoot, 'src', 'main', 'online', 'read-bounded.ts'),
    join(repoRoot, 'src', 'main', 'downloads', 'download-manager.ts'),
    join(repoRoot, 'src', 'main', 'online', 'playlist-import.ts'),
    join(repoRoot, 'src', 'main', 'online', 'artist-image.ts'),
    join(repoRoot, 'src', 'main', 'online', 'hot-words.ts'),
    join(repoRoot, 'src', 'main', 'library', 'artist-images.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'platform-probe.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-store.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-engine.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-runtime-host.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'script-header.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'codec.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'shutdown-guard.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-validator.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'restricted-launch.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'launcher-status.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'legacy-music-info.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'jj-source-protocol.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-runtime-host.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'jj-provider-engine.ts'),
    join(repoRoot, 'src', 'main', 'library', 'music-library.ts'),
    join(repoRoot, 'src', 'main', 'data-location.ts'),
    join(repoRoot, 'src', 'main', 'updates', 'manifest.ts'),
    join(repoRoot, 'src', 'main', 'updates', 'service.ts'),
    join(repoRoot, 'src', 'main', 'updates', 'release-source.ts'),
    join(repoRoot, 'src', 'main', 'library', 'embedded-lyrics.ts'),
    join(repoRoot, 'src', 'main', 'library', 'lyric-service.ts'),
    join(repoRoot, 'src', 'main', 'library', 'metadata-match.ts'),
    join(repoRoot, 'src', 'main', 'library', 'tag-writer.ts'),
  join(repoRoot, 'src', 'main', 'library', 'asset-files.ts'),
  join(repoRoot, 'src', 'main', 'library', 'asset-export.ts'),
  join(repoRoot, 'src', 'main', 'library', 'pending-assets.ts'),
    join(repoRoot, 'src', 'main', 'library', 'pending-asset-write.ts'),
    join(repoRoot, 'src', 'main', 'library', 'path-task-queue.ts'),
    join(repoRoot, 'src', 'main', 'library', 'local-file-relink.ts'),
    join(repoRoot, 'src', 'main', 'library', 'batch-file-relink.ts'),
    join(repoRoot, 'src', 'main', 'library', 'playlist-backup.ts'),
    join(repoRoot, 'src', 'main', 'library', 'playlist-restore.ts'),
    join(repoRoot, 'src', 'main', 'library', 'playlist-derive.ts'),
    join(repoRoot, 'src', 'main', 'library', 'playlist-bulk-rename.ts'),
    join(repoRoot, 'src', 'main', 'library', 'missing-files.ts'),
    join(repoRoot, 'src', 'main', 'online', 'search.ts'),
    join(repoRoot, 'src', 'main', 'online', 'search-router.ts'),
    join(repoRoot, 'src', 'main', 'online', 'platform-registry.ts'),
    join(repoRoot, 'src', 'main', 'online', 'entity-details.ts'),
    join(repoRoot, 'src', 'main', 'online', 'library-router.ts'),
    join(repoRoot, 'src', 'main', 'online', 'hot-words.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'playback-router.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-updater.ts'),
    join(repoRoot, 'src', 'main', 'ipc-validation.ts'),
    join(repoRoot, 'src', 'main', 'online', 'lyrics.ts'),
    join(repoRoot, 'src', 'main', 'online', 'url-guard.ts'),
    join(repoRoot, 'src', 'main', 'online', 'source-media-proxy.ts'),
    join(repoRoot, 'src', 'main', 'online', 'source-media-protocol.ts'),
    join(repoRoot, 'src', 'main', 'online', 'pinned-dispatcher.ts'),
    join(repoRoot, 'src', 'main', 'online', 'cover-fetch.ts'),
    join(repoRoot, 'src', 'main', 'store', 'json-file.ts'),
    join(repoRoot, 'src', 'main', 'media', 'media-response.ts'),
    join(repoRoot, 'src', 'main', 'media', 'file-release.ts'),
    join(repoRoot, 'src', 'main', 'media', 'flac-repair.ts'),
    join(repoRoot, 'src', 'main', 'store', 'settings-store.ts')
  ],
  // `outbase` is the root the output tree mirrors. Setting it to `src/main`
  // and the outdir to `out/test` means `src/main/sources/x.ts` becomes
  // `out/test/sources/x.js` and `src/main/library/y.ts` becomes
  // `out/test/library/y.js`, with no redundant nesting.
  outbase: join(repoRoot, 'src', 'main'),
  outdir: outDir,
  outExtension: { '.js': '.js' }
})

await build({
  ...shared,
  entryPoints: [
        join(repoRoot, 'src', 'shared', 'audio-engine.ts'),
        join(repoRoot, 'src', 'shared', 'dlna-errors.ts'),
        join(repoRoot, 'src', 'shared', 'crossfade.ts'),
        join(repoRoot, 'src', 'shared', 'types.ts'),
        join(repoRoot, 'src', 'shared', 'playlist-bulk-rename.ts'),
        join(repoRoot, 'src', 'shared', 'playback-reliability.ts'),
        join(repoRoot, 'src', 'shared', 'persisted-track.ts'),
        join(repoRoot, 'src', 'shared', 'media-url.ts'),
        // The overlay's geometry maths is the part of the feature that can fail
        // silently, so the suites import it the same way the app does.
        join(repoRoot, 'src', 'shared', 'desktop-lyric.ts')
      ],
  // `outfile` cannot take two entry points, so mirror the source layout instead.
  outbase: join(repoRoot, 'src', 'shared'),
  outdir: join(outDir, 'shared')
})

// Share the production audio class across the store and engine regression
// suites. Browser APIs are replaced by deterministic test doubles in tests.
await build({
  ...shared,
  external: [...shared.external, 'vue', 'pinia'],
  splitting: true,
  entryPoints: [
    join(repoRoot, 'src', 'renderer', 'src', 'audio', 'crossfade-controller.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'audio', 'lyrics.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'audio', 'web-audio-engine.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'audio', 'dlna-engine.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'audio', 'gain-transition.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'settings-writer.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'format.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'search-merge.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'cancellable-music.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'local-search.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'track-cover.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'recording-match.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'online-resolver.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'source-update-state.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'stores', 'library.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'stores', 'toast.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'stores', 'player.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'stores', 'charts.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'stores', 'playlist-search.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'playlist-preview.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'playlist-filter.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'playlist-track-filter.ts')
  ],
  outbase: join(repoRoot, 'src', 'renderer', 'src'),
  outdir: join(outDir, 'renderer'),
  outExtension: { '.js': '.js' }
})

// Exercise the real picker setup, with only the player/audio boundary substituted.
// Vue stays external so the test's effectScope owns and disposes the real watches.
const pickerPath = join(repoRoot, 'src/renderer/src/components/OutputDevicePicker.vue')
const picker = parse(readFileSync(pickerPath, 'utf8'), { filename: pickerPath })
if (picker.errors.length) throw new Error('Cannot parse production DLNA output picker')
await build({
  ...shared,
  stdin: { contents: compileScript(picker.descriptor, { id: 'dlna-picker-test', isProd: true }).content,
    loader: 'ts', resolveDir: dirname(pickerPath), sourcefile: pickerPath },
  outfile: join(outDir, 'renderer/components/output-device-picker.js'),
  external: [...shared.external, 'vue'],
  plugins: [{ name: 'picker-player-fixture', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/stores\/player$/ }, () => ({ path: 'player', namespace: 'picker-fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'picker-fixture' }, () => ({
      contents: 'export const usePlayerStore = () => globalThis.__jj_dlna_picker_player', loader: 'js'
    }))
  } }]
})

// The 音源 host runs as a forked child process, so it is built as a standalone
// CommonJS file: `fork()` executes it with `require`, not as an ES module.
await build({
  ...shared,
  format: 'cjs',
  entryPoints: [join(repoRoot, 'src', 'main', 'sources', 'source-host.ts')],
  outfile: join(outDir, 'source-host.cjs')
})

// This native Electron lifecycle probe uses the production player store and
// Web Audio engine with synthetic loopback media. Bundle Vue and Pinia here so
// Chromium can execute the same renderer code without a dev server or network.
await build({
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'JJCrossfadeLifecycleBundle',
  target: 'chrome132',
  sourcemap: false,
  logLevel: 'info',
  alias: {
    '@shared': join(repoRoot, 'src', 'shared'),
    '@main': join(repoRoot, 'src', 'main')
  },
  entryPoints: [join(repoRoot, 'tools', 'probe', 'crossfade-lifecycle-bundle.ts')],
  outfile: join(outDir, 'crossfade-lifecycle.js')
})

console.log(`\nengine bundle ready in ${outDir}`)
