/**
 * Check whether a mirror serves the electron-builder binary bundles, and
 * report the exact URL shape to use.
 *
 * electron-builder downloads its NSIS/winCodeSign tooling via @electron/get.
 * On this machine GitHub is only reachable through a local proxy, so the
 * supported escape hatch is `ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL`,
 * which prefixes every artifact filename. This script finds a working prefix.
 *
 * Usage: node tools/probe/check-builder-mirror.mjs
 */
const CANDIDATES = [
  {
    label: 'npmmirror binary mirror (v2 layout)',
    prefix: 'https://registry.npmmirror.com/-/binary/electron-builder-binaries'
  },
  {
    label: 'npmmirror /mirrors (nginx listing)',
    prefix: 'https://npmmirror.com/mirrors/electron-builder-binaries'
  },
  {
    label: 'GitHub releases (direct)',
    prefix:
      'https://github.com/electron-userland/electron-builder-binaries/releases/download'
  }
]

// The override URL is joined as `${prefix}/${filename}`, and the filename
// includes the release tag, e.g. `nsis-3.0.4.1/nsis-3.0.4.1.7z`? No — it is
// a flat join, so the release tag must be part of the prefix path.
const ARTIFACTS = [
  { release: 'nsis-3.0.4.1', file: 'nsis-3.0.4.1.7z', bytes: 1_288_000 },
  { release: 'winCodeSign-2.6.0', file: 'winCodeSign-2.6.0.7z', bytes: 5_600_000 }
]

for (const candidate of CANDIDATES) {
  console.log(`\n--- ${candidate.label} ---`)
  for (const artifact of ARTIFACTS) {
    // Two shapes are worth testing: flat (prefix + filename) and
    // release-scoped (prefix + release + filename).
    const shapes = [
      { name: 'flat', url: `${candidate.prefix}/${artifact.file}` },
      {
        name: 'release-scoped',
        url: `${candidate.prefix}/${artifact.release}/${artifact.file}`
      }
    ]

    for (const shape of shapes) {
      try {
        const response = await fetch(shape.url, { method: 'HEAD' })
        const length = Number(response.headers.get('content-length') ?? 0)
        const type = response.headers.get('content-type') ?? ''
        const ok = response.ok && length > 100_000
        console.log(
          `  ${ok ? 'OK  ' : 'no  '} [${shape.name}] ${artifact.file} ` +
            `status=${response.status} bytes=${length} type=${type.slice(0, 30)}`
        )
      } catch (error) {
        console.log(`  ERR  [${shape.name}] ${artifact.file}: ${error.message}`)
      }
    }
  }
}

console.log(
  '\nIf a shape reports OK, set:\n' +
    '  ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL=<prefix>\n' +
    'and re-run the installer build.'
)
