// Refreshes Loom's copy of Docker's default seccomp profile.
//
// Source:  https://github.com/moby/profiles  (seccomp/default.json), Apache License 2.0.
// The copy is kept exactly as Docker publishes it. What Loom adds for workspace containers
// lives in src/main/runtime/container.ts, so this file can be replaced without merging.
//
// Run it when Docker is upgraded on a host: Docker tightens this profile over time, and a
// stale copy keeps working but misses those protections. Then run the container tests.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json'
const TARGET = new URL('../src/main/runtime/docker-default-seccomp.json', import.meta.url)

const response = await fetch(SOURCE)
if (!response.ok) throw new Error(`could not fetch ${SOURCE}: ${response.status}`)
const text = await response.text()
const profile = JSON.parse(text)
if (!Array.isArray(profile.syscalls) || typeof profile.defaultAction !== 'string') {
  throw new Error('the fetched file does not look like a seccomp profile')
}
await writeFile(TARGET, text)
console.log(`wrote ${profile.syscalls.length} rules to ${fileURLToPath(TARGET)}`)
