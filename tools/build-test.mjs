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
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  external: ['electron', 'iconv-lite', 'music-metadata', 'node-id3'],
  alias: {
    '@shared': join(repoRoot, 'src', 'shared'),
    '@main': join(repoRoot, 'src', 'main')
  }
}

await build({
  ...shared,
  entryPoints: [
    join(repoRoot, 'src', 'main', 'online', 'read-bounded.ts'),
    join(repoRoot, 'src', 'main', 'downloads', 'download-manager.ts'),
    join(repoRoot, 'src', 'main', 'online', 'playlist-import.ts'),
    join(repoRoot, 'src', 'main', 'online', 'artist-image.ts'),
    join(repoRoot, 'src', 'main', 'online', 'hot-words.ts'),
    join(repoRoot, 'src', 'main', 'library', 'artist-images.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'platform-probe.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-store.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-engine.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'script-header.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'codec.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'shutdown-guard.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'source-validator.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'restricted-launch.ts'),
    join(repoRoot, 'src', 'main', 'sources', 'legacy-music-info.ts'),
    join(repoRoot, 'src', 'main', 'library', 'music-library.ts'),
    join(repoRoot, 'src', 'main', 'data-location.ts'),
    join(repoRoot, 'src', 'main', 'library', 'embedded-lyrics.ts'),
    join(repoRoot, 'src', 'main', 'library', 'lyric-service.ts'),
    join(repoRoot, 'src', 'main', 'library', 'metadata-match.ts'),
    join(repoRoot, 'src', 'main', 'library', 'tag-writer.ts'),
  join(repoRoot, 'src', 'main', 'library', 'asset-files.ts'),
  join(repoRoot, 'src', 'main', 'library', 'asset-export.ts'),
  join(repoRoot, 'src', 'main', 'library', 'pending-assets.ts'),
    join(repoRoot, 'src', 'main', 'online', 'search.ts'),
    join(repoRoot, 'src', 'main', 'online', 'lyrics.ts'),
    join(repoRoot, 'src', 'main', 'online', 'url-guard.ts'),
    join(repoRoot, 'src', 'main', 'store', 'json-file.ts'),
    join(repoRoot, 'src', 'main', 'media', 'media-response.ts'),
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
    join(repoRoot, 'src', 'renderer', 'src', 'audio', 'lyrics.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'audio', 'web-audio-engine.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'settings-writer.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'utils', 'local-search.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'stores', 'library.ts'),
    join(repoRoot, 'src', 'renderer', 'src', 'stores', 'player.ts')
  ],
  outbase: join(repoRoot, 'src', 'renderer', 'src'),
  outdir: join(outDir, 'renderer'),
  outExtension: { '.js': '.js' }
})

// The 音源 host runs as a forked child process, so it is built as a standalone
// CommonJS file: `fork()` executes it with `require`, not as an ES module.
await build({
  ...shared,
  format: 'cjs',
  entryPoints: [join(repoRoot, 'src', 'main', 'sources', 'source-host.ts')],
  outfile: join(outDir, 'source-host.cjs')
})

console.log(`\nengine bundle ready in ${outDir}`)
