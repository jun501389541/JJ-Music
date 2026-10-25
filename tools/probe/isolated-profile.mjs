import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

export async function withDisposableProfile(parentDir, run) {
  const profile = await mkdtemp(join(parentDir, 'native-profile-'))
  try {
    return await run(profile)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}
