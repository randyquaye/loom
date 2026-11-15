import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const helper = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-release-signing-'))
  roots.push(root)
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'images/workspace/Dockerfile',
    'images/workspace-kata/Dockerfile',
    'infra/kata/install.sh',
    'infra/host/setup.sh',
    'infra/host/configure.sh',
    'infra/host/.terraform.lock.hcl',
    'infra/host/stacks/example.env',
    'docs/operator-setup.md',
    'docs/operator-runbook.md',
    'docs/releases.md',
    'docs/security.md',
    'docs/member-guide.md',
    'out/main/runner.js',
    'out/main/restore-check.js',
    'out/main/transport-proof.js',
    'out/main/chunks/runtime.js'
  ]
  for (const name of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), name === 'package.json' ? '{}' : 'fixture')
  }
  await mkdir(path.join(root, 'src/shared'), { recursive: true })
  await writeFile(path.join(root, 'src/shared/runner-contract.ts'), 'export const RUNNER_PROTOCOL = 6\n')
  await mkdir(path.join(root, 'desktop'))
  for (const ext of ['dmg', 'zip'])
    await writeFile(path.join(root, `desktop/Loom-1.2.3-arm64.${ext}`), `fixture ${ext}`)
  await mkdir(path.join(root, 'bin'))
  const command = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2), name = path.basename(process.argv[1])
const value = flag => args[args.indexOf(flag) + 1]
const sha = 'a'.repeat(40)
if (name === 'git') {
  if (args[0] === 'status') process.exit(0)
  if (args[0] === 'rev-parse') { console.log(sha); process.exit(0) }
  const walk = file => fs.statSync(file).isDirectory()
    ? fs.readdirSync(file).flatMap(child => walk(path.join(file, child))) : [file]
  process.stdout.write(args.slice(args.indexOf('--') + 1).filter(fs.existsSync).flatMap(walk).join('\\0'))
  process.exit(0)
}
fs.appendFileSync('gh-calls.jsonl', JSON.stringify(args) + '\\n')
const stateFile = 'gh-state.json'
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {}
if (args[0] === 'api') {
  const endpoint = args[1]
  if (endpoint.endsWith('/git/refs') && value('--method') === 'POST') {
    state.tag = true; fs.writeFileSync(stateFile, JSON.stringify(state)); console.log('{}'); process.exit(0)
  }
  if (endpoint.includes('/commits/')) { console.log(JSON.stringify({sha})); process.exit(0) }
  if (endpoint.includes('/releases/tags/') && state.published) {
    console.log(JSON.stringify({tag_name:'desktop-v1.2.3',draft:false,prerelease:false,immutable:true})); process.exit(0)
  }
  if (endpoint.endsWith('/releases/tags/desktop-v0.9.0')) {
    console.log(JSON.stringify({tag_name:'desktop-v0.9.0',draft:false,prerelease:false,immutable:true})); process.exit(0)
  }
  console.error('gh: Not Found (HTTP 404)'); process.exit(1)
}
if (args[0] === 'release' && args[1] === 'download') {
  fs.copyFileSync(path.join('remote',value('--pattern')),path.join(value('--dir'),value('--pattern')))
}
if (args[0] === 'release' && args[1] === 'edit') {
  state.published = true; fs.writeFileSync(stateFile, JSON.stringify(state))
}
process.exit(0)
`
  for (const name of ['git', 'gh']) {
    await writeFile(path.join(root, 'bin', name), command)
    await chmod(path.join(root, 'bin', name), 0o755)
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env['PATH']}`,
    GITHUB_REPOSITORY: 'example/loom',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40)
  }
  for (const key of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID'
  ])
    delete env[key]
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [helper, ...args], {
      cwd: root,
      env,
      encoding: 'utf8'
    })
  const manifest = async (name = 'desktop/desktop.json') =>
    JSON.parse(await readFile(path.join(root, name), 'utf8'))
  const calls = async (): Promise<string[][]> =>
    (await readFile(path.join(root, 'gh-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  return { root, run, manifest, calls }
}

it.each(['unsigned', 'signed'])(
  'records an explicit %s desktop status alongside artifact checksums',
  async (signing) => {
    const f = await fixture()
    const result = f.run('desktop', '1.2.3', 'desktop', signing)
    expect(result.status, result.stderr).toBe(0)
    const manifest = await f.manifest()
    expect(manifest.signing).toBe(signing)
    expect(manifest.assets[0].sha256).toBe(createHash('sha256').update('fixture dmg').digest('hex'))
  }
)

it('refuses an ambiguous signing mode before writing release metadata', async () => {
  const f = await fixture()
  const result = f.run('desktop', '1.2.3', 'desktop', 'maybe')
  expect(result.status).not.toBe(0)
  await expect(readFile(path.join(f.root, 'desktop/desktop.json'))).rejects.toThrow()
})

it('labels the published unsigned pilot and its installation requirement without Apple credentials', async () => {
  const f = await fixture()
  expect(f.run('desktop', '1.2.3', 'desktop', 'unsigned').status).toBe(0)
  const result = f.run('publish', 'desktop', '1.2.3', 'desktop')
  expect(result.status, result.stderr).toBe(0)
  const create = (await f.calls()).find((args) => args[0] === 'release' && args[1] === 'create')!
  expect(create[create.indexOf('--title') + 1]).toMatch(/unsigned/i)
  expect(create[create.indexOf('--notes') + 1]).toMatch(/unsigned/i)
  expect(create[create.indexOf('--notes') + 1]).toMatch(/Privacy.*Security|Open Anyway/i)
})

it('rejects missing desktop signing metadata before creating a GitHub tag', async () => {
  const f = await fixture()
  expect(f.run('desktop', '1.2.3', 'desktop', 'unsigned').status).toBe(0)
  const manifest = await f.manifest()
  delete manifest.signing
  await writeFile(path.join(f.root, 'desktop/desktop.json'), JSON.stringify(manifest))
  expect(f.run('publish', 'desktop', '1.2.3', 'desktop').status).not.toBe(0)
  expect((await f.calls()).some((args) => args.includes('POST'))).toBe(false)
})

it.each(['unsigned', 'signed'])(
  'preserves the selected %s desktop status in a runner release',
  async (signing) => {
    const f = await fixture()
    expect(f.run('desktop', '1.2.3', 'desktop', signing).status).toBe(0)
    const manifest = await f.manifest()
    manifest.version = '0.9.0'
    manifest.assets = manifest.assets.map((asset: { name: string }) => ({
      ...asset,
      name: asset.name.replace('1.2.3', '0.9.0')
    }))
    await mkdir(path.join(f.root, 'remote'))
    await writeFile(path.join(f.root, 'remote/desktop.json'), JSON.stringify(manifest))
    for (const ext of ['dmg', 'zip'])
      await writeFile(path.join(f.root, `remote/Loom-0.9.0-arm64.${ext}`), `fixture ${ext}`)
    const result = f.run('runner', '1.2.3', 'desktop-v0.9.0', 'runner')
    expect(result.status, result.stderr).toBe(0)
    expect((await f.manifest('runner/runner.json')).desktop.signing).toBe(signing)
  }
)
