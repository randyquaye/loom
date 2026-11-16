import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const helper = fileURLToPath(new URL('../scripts/notarize.mjs', import.meta.url))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-notarization-'))
  roots.push(root)
  await mkdir(path.join(root, 'release/desktop'), { recursive: true })
  await mkdir(path.join(root, 'release/notarization'))
  await mkdir(path.join(root, 'bin'))
  const input = 'release/desktop/Loom-1.2.3-arm64.dmg'
  await writeFile(path.join(root, input), 'signed exact bytes')
  const checkpoint = {
    schemaVersion: 1,
    version: '1.2.3',
    commit: 'a'.repeat(40),
    teamId: 'ABCDE12345',
    platform: 'darwin-arm64',
    updateUrl: 'https://downloads.example.test/desktop/',
    stage: 'dmg',
    input,
    sha256: createHash('sha256').update('signed exact bytes').digest('hex'),
    submissionId: '11111111-2222-3333-4444-555555555555'
  }
  const checkpointPath = path.join(root, 'release/notarization/checkpoint.json')
  await writeFile(checkpointPath, JSON.stringify(checkpoint))
  await writeFile(
    path.join(root, 'bin/platform.cjs'),
    "Object.defineProperty(process, 'platform', {value: 'darwin'}); Object.defineProperty(process, 'arch', {value: 'arm64'})"
  )
  const command = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2), name = path.basename(process.argv[1])
fs.appendFileSync('calls.jsonl',JSON.stringify([name,...args])+'\\n')
const state = JSON.parse(fs.readFileSync('release/notarization/checkpoint.json'))
if (name === 'git') console.log('a'.repeat(40))
if (name === 'codesign' && args[0] === '-dvv') console.error('TeamIdentifier=ABCDE12345')
if (name === 'ditto') {
  fs.mkdirSync(path.join(args[3],'Loom.app'),{recursive:true})
  fs.writeFileSync(path.join(args[3],'Loom.app/original-marker'),fs.readFileSync(args[2]))
}
if (name === 'xcrun' && args[0] === 'notarytool') {
  if (args[1] === 'wait') console.log(JSON.stringify({id:state.submissionId,status:process.env.NOTARY_STATUS || 'Accepted'}))
  if (args[1] === 'log') console.log(JSON.stringify({jobId:state.submissionId,status:'Accepted',sha256:state.sha256}))
}
`
  for (const name of ['git', 'codesign', 'xcrun', 'spctl', 'ditto']) {
    await writeFile(path.join(root, 'bin', name), command)
    await chmod(path.join(root, 'bin', name), 0o755)
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env['PATH']}`,
    GITHUB_SHA: 'a'.repeat(40),
    RELEASE_SOURCE_SHA: 'a'.repeat(40),
    APPLE_ID: 'operator@example.test',
    APPLE_APP_SPECIFIC_PASSWORD: 'fixture-only',
    APPLE_TEAM_ID: 'ABCDE12345',
    VERSION: '1.2.3',
    LOOM_DESKTOP_UPDATE_URL: 'https://downloads.example.test/desktop/'
  }
  const run = () =>
    spawnSync(
      process.execPath,
      ['--require', path.join(root, 'bin/platform.cjs'), helper, 'resume', '1.2.3'],
      { cwd: root, env, encoding: 'utf8' }
    )
  const calls = async (): Promise<string[][]> => {
    try {
      return (await readFile(path.join(root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  return { root, input, checkpoint, checkpointPath, env, run, calls }
}

it('resumes the existing submission without uploading again, then validates stapling', async () => {
  const f = await fixture()
  const result = f.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = await f.calls()
  expect(calls.some((args) => args[0] === 'xcrun' && args[2] === 'submit')).toBe(false)
  expect(calls.find((args) => args[2] === 'wait')?.[3]).toBe(f.checkpoint.submissionId)
  expect(calls.some((args) => args[1] === 'stapler' && args[2] === 'validate')).toBe(true)
})

it('refuses recovery after the submitted bytes change before contacting Apple', async () => {
  const f = await fixture()
  await writeFile(path.join(f.root, f.input), 'changed bytes')
  expect(f.run().status).not.toBe(0)
  expect((await f.calls()).some((args) => args[0] === 'xcrun')).toBe(false)
})

it('refuses recovery under another signing team before contacting Apple', async () => {
  const f = await fixture()
  f.env.APPLE_TEAM_ID = 'OTHER12345'
  expect(f.run().status).not.toBe(0)
  expect((await f.calls()).some((args) => args[0] === 'xcrun')).toBe(false)
})

it('retains a rejected submission and never staples or silently resubmits it', async () => {
  const f = await fixture()
  const result = spawnSync(
    process.execPath,
    ['--require', path.join(f.root, 'bin/platform.cjs'), helper, 'resume', '1.2.3'],
    {
      cwd: f.root,
      env: { ...f.env, NOTARY_STATUS: 'Invalid' },
      encoding: 'utf8'
    }
  )
  expect(result.status).not.toBe(0)
  expect(JSON.parse(await readFile(f.checkpointPath, 'utf8')).submissionId).toBe(f.checkpoint.submissionId)
  expect((await f.calls()).some((args) => args[2] === 'staple' || args[2] === 'submit')).toBe(false)
})

it('reconstructs the app from the submitted ZIP instead of trusting a different retained app', async () => {
  const f = await fixture()
  const original = 'original submitted application'
  const input = 'release/notarization/app.zip'
  await writeFile(path.join(f.root, input), original)
  await writeFile(
    f.checkpointPath,
    JSON.stringify({
      ...f.checkpoint,
      stage: 'app',
      input,
      sha256: createHash('sha256').update(original).digest('hex')
    })
  )
  const app = path.join(f.root, 'release/desktop/mac-arm64/Loom.app')
  await mkdir(app, { recursive: true })
  await writeFile(path.join(app, 'original-marker'), 'another signed application')
  const result = f.run()
  expect(result.status, result.stderr).toBe(0)
  expect(await readFile(path.join(app, 'original-marker'), 'utf8')).toBe(original)
  expect((await f.calls()).some((args) => args[2] === 'submit')).toBe(false)
})

it('recovers the verified original source after the dispatch branch advances', async () => {
  const f = await fixture()
  f.env['GITHUB_SHA'] = 'b'.repeat(40)
  f.env['RELEASE_SOURCE_SHA'] = f.checkpoint.commit
  const result = f.run()
  expect(result.status, result.stderr).toBe(0)
  expect((await f.calls()).some((args) => args[2] === 'submit')).toBe(false)
})
