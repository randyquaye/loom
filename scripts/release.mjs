// Separate desktop/runner releases share only their exact wire protocol, not version numbers.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  })
}
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
function versionOf(value) {
  requireValue(
    typeof value === 'string' &&
      value.length < 50 &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value),
    'Use a version such as 1.2.3'
  )
  return value
}
function tagOf(kind, version) {
  requireValue(kind === 'desktop' || kind === 'runner', 'Release kind must be desktop or runner')
  return `${kind}-v${versionOf(version)}`
}
function repository() {
  const repo = process.env.GITHUB_REPOSITORY
  requireValue(
    typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo),
    'Set GITHUB_REPOSITORY to owner/repo'
  )
  return repo
}
function gh(args) {
  return run('gh', [...args, '--repo', repository()])
}
function api(endpoint, args = []) {
  return JSON.parse(run('gh', ['api', `repos/${repository()}/${endpoint}`, ...args]))
}
function absent(endpoint) {
  try {
    api(endpoint)
  } catch (error) {
    if (String(error.stderr).includes('(HTTP 404)')) return
    throw error
  }
  throw new Error(`Release/tag already exists: ${endpoint}`)
}
async function source(kind, version) {
  tagOf(kind, version)
  requireValue(
    run('git', ['status', '--porcelain', '--untracked-files=normal']).trim() === '',
    'Release source must be clean'
  )
  const commit = run('git', ['rev-parse', 'HEAD']).trim()
  requireValue(/^[a-f0-9]{40}$/.test(commit), 'Expected full source commit SHA')
  requireValue(
    !process.env.GITHUB_SHA || process.env.GITHUB_SHA === commit,
    'Checked-out source differs from workflow SHA'
  )
  const text = await readFile('src/shared/runner-contract.ts', 'utf8')
  const match = text.match(/^export const RUNNER_PROTOCOL = (\d+)\s*$/m)
  requireValue(match !== null && Number.isSafeInteger(Number(match[1])), 'Cannot read RUNNER_PROTOCOL')
  return { schemaVersion: 1, kind, version, protocol: Number(match[1]), commit }
}
async function inspect(kind, version) {
  requireValue(process.env.GITHUB_REF === 'refs/heads/main', 'Releases run from main only')
  const info = await source(kind, version)
  const tag = tagOf(kind, version)
  absent(`git/ref/tags/${tag}`)
  absent(`releases/tags/${tag}`)
  return { ...info, tag }
}
async function digest(file) {
  const info = await lstat(file)
  requireValue(
    info.isFile() && info.size > 0 && Number.isSafeInteger(info.size),
    `Expected a nonempty regular file: ${file}`
  )
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return { name: path.basename(file), sha256: hash.digest('hex'), size: info.size }
}
function names(kind, version) {
  return kind === 'desktop'
    ? [`Loom-${version}-arm64.dmg`, `Loom-${version}-arm64.zip`]
    : [`loom-runner-${version}.tgz`, `loom-operator-${version}.tgz`]
}
async function checkAssets(manifest, directory) {
  const expected = names(manifest.kind, manifest.version)
  requireValue(
    Array.isArray(manifest.assets) && manifest.assets.length === expected.length,
    'Unexpected release assets'
  )
  for (const name of expected) {
    const entries = manifest.assets.filter((entry) => entry.name === name)
    requireValue(entries.length === 1, `Missing or repeated asset: ${name}`)
    const actual = await digest(path.join(directory, name))
    requireValue(
      entries[0].sha256 === actual.sha256 && entries[0].size === actual.size,
      `Checksum or size mismatch: ${name}`
    )
  }
}
function checkManifest(manifest, kind, version) {
  requireValue(
    manifest?.schemaVersion === 1 &&
      manifest.kind === kind &&
      manifest.version === version &&
      Number.isSafeInteger(manifest.protocol) &&
      manifest.protocol > 0 &&
      /^[a-f0-9]{40}$/.test(manifest.commit),
    'Invalid release manifest identity'
  )
  if (kind === 'desktop') signingOf(manifest.signing)
}
function signingOf(value) {
  requireValue(value === 'signed' || value === 'unsigned', 'Signing must be signed or unsigned')
  return value
}
async function saveManifest(info, directory, extra = {}) {
  const manifest = {
    ...info,
    ...extra,
    assets: await Promise.all(
      names(info.kind, info.version).map((name) => digest(path.join(directory, name)))
    )
  }
  await writeFile(path.join(directory, `${info.kind}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
async function desktop(version, directory, signing) {
  signingOf(signing)
  return saveManifest(await source('desktop', version), directory, { signing })
}
async function verifiedDesktop(tag, directory) {
  requireValue(/^desktop-v/.test(tag), 'Select an existing desktop-vVERSION release')
  const version = versionOf(tag.slice('desktop-v'.length))
  const release = api(`releases/tags/${tag}`)
  requireValue(
    release.tag_name === tag &&
      release.immutable === true &&
      release.draft === false &&
      release.prerelease === false,
    'Desktop release must be published and immutable'
  )
  gh(['release', 'verify', tag])
  gh(['release', 'download', tag, '--pattern', 'desktop.json', '--dir', directory])
  gh(['release', 'verify-asset', tag, path.join(directory, 'desktop.json')])
  const manifest = JSON.parse(await readFile(path.join(directory, 'desktop.json'), 'utf8'))
  checkManifest(manifest, 'desktop', version)
  requireValue(
    api(`commits/${tag}`).sha === manifest.commit,
    'Desktop manifest does not match its source tag'
  )
  for (const name of names('desktop', version)) {
    gh(['release', 'download', tag, '--pattern', name, '--dir', directory])
    gh(['release', 'verify-asset', tag, path.join(directory, name)])
  }
  await checkAssets(manifest, directory)
  return manifest
}
async function copy(sourceFile, destination, relative = sourceFile) {
  requireValue(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'Invalid package path')
  const info = await lstat(sourceFile)
  requireValue(info.isFile(), `Package input must be a regular file: ${sourceFile}`)
  const target = path.join(destination, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(sourceFile, target)
}
function tracked(paths) {
  return run('git', ['ls-files', '-z', '--', ...paths])
    .split('\0')
    .filter(Boolean)
}
async function archive(directory, output, files) {
  requireValue(files.length > 0, 'Cannot create an empty archive')
  run('tar', ['--no-xattrs', '-czf', output, '-C', directory, '--', ...files])
}
async function runner(version, desktopTag, output) {
  const info = await source('runner', version)
  const tag = tagOf('runner', version)
  const temporary = await mkdtemp(path.join(tmpdir(), 'loom-release-'))
  try {
    const downloads = path.join(temporary, 'desktop')
    await mkdir(downloads)
    const selected = await verifiedDesktop(desktopTag, downloads)
    requireValue(selected.protocol === info.protocol, 'Desktop and runner protocols differ')
    await mkdir(output, { recursive: true })
    requireValue((await readdir(output)).length === 0, 'Runner output directory must be empty')
    const runtime = path.join(temporary, 'runtime')
    const operator = path.join(temporary, 'operator')
    const runtimeFiles = tracked([
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'images/workspace',
      'images/workspace-kata',
      'infra/kata',
      'infra/host/setup.sh',
      'infra/host/prepare.sh',
      'infra/host/configure.sh',
      'infra/host/host-record.mjs',
      'infra/host/transport-proof.sh',
      'infra/host/monitoring.sh',
      'infra/host/snapshot-age.sh',
      'infra/host/loom-workspace.apparmor',
      'infra/host/restore-host.sh'
    ])
    for (const required of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'infra/host/setup.sh',
      'infra/host/configure.sh'
    ])
      requireValue(runtimeFiles.includes(required), `Missing tracked runtime input: ${required}`)
    runtimeFiles.push('out/main/runner.js', 'out/main/restore-check.js', 'out/main/transport-proof.js')
    for (const entry of await readdir('out/main/chunks', { withFileTypes: true })) {
      requireValue(entry.isFile() && entry.name.endsWith('.js'), 'Unexpected runner chunk file')
      runtimeFiles.push(`out/main/chunks/${entry.name}`)
    }
    for (const file of runtimeFiles) await copy(file, runtime)
    await copy(path.join(downloads, names('desktop', selected.version)[0]), runtime, 'download/Loom.dmg')
    await writeFile(path.join(runtime, 'download/release.txt'), `${tag}\n`)
    runtimeFiles.push('download/Loom.dmg', 'download/release.txt')
    const operatorFiles = tracked([
      'infra/host',
      'infra/kata',
      'docs/operator-setup.md',
      'docs/operator-runbook.md',
      'docs/releases.md',
      'docs/security.md',
      'docs/member-guide.md'
    ]).filter(
      (file) =>
        /^infra\/host\/[^/]+\.(sh|tf|mjs)$/.test(file) ||
        [
          'infra/host/.terraform.lock.hcl',
          'infra/host/stacks/example.env',
          'infra/host/loom-workspace.apparmor'
        ].includes(file) ||
        file.startsWith('infra/kata/') ||
        file.startsWith('docs/')
    )
    for (const required of [
      'infra/host/.terraform.lock.hcl',
      'infra/host/stacks/example.env',
      'docs/releases.md'
    ])
      requireValue(operatorFiles.includes(required), `Missing tracked operator input: ${required}`)
    for (const file of operatorFiles) await copy(file, operator)
    await writeFile(path.join(operator, 'infra/host/operator-release.txt'), `${tag}\n`)
    operatorFiles.push('infra/host/operator-release.txt')
    await archive(runtime, path.resolve(output, names('runner', version)[0]), runtimeFiles)
    await archive(operator, path.resolve(output, names('runner', version)[1]), operatorFiles)
    return await saveManifest(info, output, {
      desktop: {
        tag: desktopTag,
        version: selected.version,
        protocol: selected.protocol,
        commit: selected.commit,
        signing: selected.signing
      }
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
async function publish(kind, version, directory) {
  const info = await inspect(kind, version)
  const manifest = JSON.parse(await readFile(path.join(directory, `${kind}.json`), 'utf8'))
  checkManifest(manifest, kind, version)
  requireValue(
    manifest.protocol === info.protocol && manifest.commit === info.commit,
    'Manifest does not match checked source'
  )
  if (kind === 'runner')
    requireValue(
      manifest.desktop?.tag === tagOf('desktop', manifest.desktop?.version) &&
        manifest.desktop.protocol === info.protocol &&
        /^[a-f0-9]{40}$/.test(manifest.desktop.commit),
      'Invalid desktop binding'
    )
  const signing = signingOf(kind === 'desktop' ? manifest.signing : manifest.desktop.signing)
  await checkAssets(manifest, directory)
  const tag = info.tag
  // Creating the tag atomically prevents a concurrent publisher from changing its source.
  api('git/refs', [
    '--method',
    'POST',
    '--raw-field',
    `ref=refs/tags/${tag}`,
    '--raw-field',
    `sha=${info.commit}`
  ])
  gh([
    'release',
    'create',
    tag,
    '--draft',
    '--verify-tag',
    '--target',
    info.commit,
    '--title',
    `${tag}${signing === 'unsigned' ? ' (unsigned pilot)' : ''}`,
    '--notes',
    `${kind} ${version}; protocol ${info.protocol}; source ${info.commit}\n\nDesktop: ${signing}.` +
      (signing === 'unsigned'
        ? '\nThis pilot desktop is unsigned and not notarized. After opening the installed app, use System Settings > Privacy & Security > Open Anyway if macOS blocks it. Managed company devices may require administrator approval.'
        : '\nThe desktop is signed with Developer ID and notarized by Apple.'),
    '--latest=false'
  ])
  gh([
    'release',
    'upload',
    tag,
    path.join(directory, `${kind}.json`),
    ...names(kind, version).map((name) => path.join(directory, name))
  ])
  requireValue(api(`commits/${tag}`).sha === info.commit, 'Published tag differs from checked source')
  gh(['release', 'edit', tag, '--draft=false', '--latest=false'])
  const release = api(`releases/tags/${tag}`)
  if (release.immutable !== true) {
    gh(['release', 'edit', tag, '--draft=true'])
    throw new Error('Enable immutable releases before publishing; release returned to draft')
  }
  requireValue(
    release.tag_name === tag && release.draft === false && release.prerelease === false,
    'Unexpected published release identity'
  )
  requireValue(
    api(`commits/${tag}`).sha === info.commit,
    'Published immutable tag differs from source manifest'
  )
  // GitHub generates release attestations asynchronously after publication.
  for (let attempt = 0; ; attempt++) {
    try {
      gh(['release', 'verify', tag])
      break
    } catch (error) {
      if (attempt === 30) throw error
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
  for (const name of [`${kind}.json`, ...names(kind, version)])
    gh(['release', 'verify-asset', tag, path.join(directory, name)])
  return { tag, commit: info.commit }
}

try {
  const [command, ...args] = process.argv.slice(2)
  const commands = { inspect, desktop, runner, publish }
  const arity = { inspect: 2, desktop: 3, runner: 3, publish: 3 }
  requireValue(
    Object.hasOwn(commands, command) && args.length === arity[command],
    'Usage: release.mjs inspect KIND VERSION | desktop VERSION DIR signed|unsigned | runner VERSION DESKTOP_TAG DIR | publish KIND VERSION DIR'
  )
  console.log(JSON.stringify(await commands[command](...args)))
} catch (error) {
  console.error(`[loom-release] ${error.message}`)
  process.exitCode = 1
}
