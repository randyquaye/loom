// Both builder's afterSign hook and recovery use the same exact submitted bytes.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = 'release/notarization'
const checkpointFile = `${directory}/checkpoint.json`
const app = 'release/desktop/mac-arm64/Loom.app'
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      ...options
    })
  } catch {
    // Child-process errors include argv; never expose the app-specific password.
    throw new Error(`${command} ${args[0]} failed; inspect the preserved notarization artifacts`)
  }
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
function credentials() {
  for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'])
    requireValue(process.env[key], `Missing ${key}`)
  return [
    '--apple-id',
    process.env.APPLE_ID,
    '--password',
    process.env.APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id',
    process.env.APPLE_TEAM_ID
  ]
}
function checkEnvironment(version) {
  requireValue(
    process.platform === 'darwin' && process.arch === 'arm64',
    'Notarization requires Apple Silicon macOS'
  )
  requireValue(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'Invalid desktop version')
  requireValue(!process.env.VERSION || process.env.VERSION === version, 'Workflow version differs')
  credentials()
  const commit = run('git', ['rev-parse', 'HEAD']).trim()
  requireValue(/^[a-f0-9]{40}$/.test(commit), 'Expected full source SHA')
  const expectedSource = process.env.RELEASE_SOURCE_SHA || process.env.GITHUB_SHA
  requireValue(!expectedSource || expectedSource === commit, 'Workflow source differs')
  requireValue(/^[A-Z0-9]{10}$/.test(process.env.APPLE_TEAM_ID), 'Invalid Apple team')
  return commit
}
function verifySignature(target) {
  run('codesign', ['--verify', '--deep', '--strict', target])
  // codesign writes its identity on stderr, so capture both streams without printing argv.
  const result = spawnSync('codesign', ['-dvv', target], { encoding: 'utf8' })
  requireValue(
    result.status === 0 &&
      `${result.stdout}${result.stderr}`.split('\n').includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`),
    'Signed artifact belongs to another Apple team'
  )
}
function save(checkpoint) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(`${checkpointFile}.tmp`, `${JSON.stringify(checkpoint, null, 2)}\n`)
  renameSync(`${checkpointFile}.tmp`, checkpointFile)
}
function snapshot() {
  const files = ['release/desktop', checkpointFile]
  if (existsSync(`${directory}/app.zip`)) files.push(`${directory}/app.zip`)
  run('tar', ['--no-xattrs', '-czf', `${directory}/recovery.tgz.tmp`, ...files])
  renameSync(`${directory}/recovery.tgz.tmp`, `${directory}/recovery.tgz`)
}
function readCheckpoint(version) {
  const checkpoint = JSON.parse(readFileSync(checkpointFile, 'utf8'))
  const commit = checkEnvironment(version)
  requireValue(
    checkpoint.schemaVersion === 1 &&
      checkpoint.version === version &&
      checkpoint.commit === commit &&
      checkpoint.teamId === process.env.APPLE_TEAM_ID &&
      checkpoint.platform === `${process.platform}-${process.arch}` &&
      checkpoint.updateUrl === process.env.LOOM_DESKTOP_UPDATE_URL,
    'Recovery source, version, platform, team, or update URL differs'
  )
  requireValue(['app', 'dmg'].includes(checkpoint.stage), 'Invalid notarization stage')
  const input =
    checkpoint.stage === 'app' ? `${directory}/app.zip` : `release/desktop/Loom-${version}-arm64.dmg`
  requireValue(
    checkpoint.input === input && /^[a-f0-9]{64}$/.test(checkpoint.sha256),
    'Invalid recovery input'
  )
  requireValue(
    sha256(input) === (checkpoint.completed ? checkpoint.completedSha256 : checkpoint.sha256),
    'Submitted artifact bytes changed'
  )
  return checkpoint
}
function finish(checkpoint, recovering = false) {
  const target = checkpoint.stage === 'app' ? app : checkpoint.input
  if (recovering && checkpoint.stage === 'app') {
    // The retained tree is not the submitted archive. Reconstruct the hash-verified input.
    rmSync(app, { recursive: true, force: true })
    run('ditto', ['-x', '-k', checkpoint.input, path.dirname(app)])
    // Extraction restores the pre-stapled app; reuse the same accepted submission.
    checkpoint.completed = false
  }
  verifySignature(target)
  if (!checkpoint.completed) {
    requireValue(
      /^[a-f0-9-]{36}$/i.test(checkpoint.submissionId ?? ''),
      'Submission ID missing: inspect Apple history; never blindly submit again'
    )
    const args = credentials()
    const result = JSON.parse(
      run(
        'xcrun',
        [
          'notarytool',
          'wait',
          checkpoint.submissionId,
          ...args,
          '--timeout',
          '20m',
          '--output-format',
          'json'
        ],
        { timeout: 21 * 60 * 1000 }
      )
    )
    writeFileSync(`${directory}/${checkpoint.stage}-result.json`, `${JSON.stringify(result, null, 2)}\n`)
    requireValue(
      result.id === checkpoint.submissionId && result.status === 'Accepted',
      `Apple submission ${checkpoint.submissionId} is ${result.status}; resume this submission after diagnosis`
    )
    const log = JSON.parse(run('xcrun', ['notarytool', 'log', checkpoint.submissionId, ...args]))
    writeFileSync(`${directory}/${checkpoint.stage}-log.json`, `${JSON.stringify(log, null, 2)}\n`)
    requireValue(
      log.jobId === checkpoint.submissionId && log.sha256 === checkpoint.sha256 && log.status === 'Accepted',
      'Apple accepted a different input; refusing to staple'
    )
    run('xcrun', ['stapler', 'staple', target])
  }
  run('xcrun', ['stapler', 'validate', target])
  verifySignature(target)
  run(
    'spctl',
    checkpoint.stage === 'app'
      ? ['--assess', '--type', 'execute', target]
      : ['--assess', '--type', 'open', '--context', 'context:primary-signature', target]
  )
  checkpoint.completed = true
  checkpoint.completedSha256 = sha256(checkpoint.input)
  save(checkpoint)
  snapshot()
  return checkpoint.stage
}
async function submit(stage, target, version) {
  const commit = checkEnvironment(version)
  requireValue(
    stage === 'app'
      ? path.resolve(target) === path.resolve(app)
      : target === `release/desktop/Loom-${version}-arm64.dmg`,
    'Unexpected signed artifact path'
  )
  if (existsSync(checkpointFile)) {
    const previous = readCheckpoint(version)
    requireValue(
      stage === 'dmg' && previous.stage === 'app' && previous.completed === true,
      'An existing submission must be resumed; refusing another upload'
    )
  }
  verifySignature(target)
  const { desktopUpdateSettings } = await import('./desktop-update-config.mjs')
  const updates = desktopUpdateSettings(process.env.LOOM_DESKTOP_UPDATE_URL, process.env.APPLE_TEAM_ID)
  mkdirSync(directory, { recursive: true })
  const input = stage === 'app' ? `${directory}/app.zip` : target
  if (stage === 'app') run('ditto', ['-c', '-k', '--keepParent', target, input])
  const checkpoint = {
    schemaVersion: 1,
    version,
    commit,
    teamId: updates.teamId,
    platform: `${process.platform}-${process.arch}`,
    updateUrl: process.env.LOOM_DESKTOP_UPDATE_URL,
    stage,
    input,
    sha256: sha256(input)
  }
  save(checkpoint)
  snapshot() // Preserve the exact input even if the submission response is lost.
  const result = JSON.parse(
    run('xcrun', ['notarytool', 'submit', input, ...credentials(), '--output-format', 'json'])
  )
  requireValue(/^[a-f0-9-]{36}$/i.test(result.id ?? ''), 'Apple did not return a submission ID')
  checkpoint.submissionId = result.id
  save(checkpoint) // Persist the ID immediately, before waiting or another network call.
  snapshot()
  return finish(checkpoint)
}
export default async function afterSign(context) {
  await submit(
    'app',
    path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    context.packager.appInfo.version
  )
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ;(async () => {
    const [command, version] = process.argv.slice(2)
    requireValue(
      process.argv.length === 4 && ['dmg', 'resume', 'stage'].includes(command),
      'Usage: notarize.mjs dmg|resume|stage VERSION'
    )
    if (command === 'dmg') await submit('dmg', `release/desktop/Loom-${version}-arm64.dmg`, version)
    else {
      const checkpoint = readCheckpoint(version)
      if (command === 'resume') finish(checkpoint, true)
      console.log(checkpoint.stage)
    }
  })().catch((error) => {
    console.error(`[loom-notarization] ${error.message}`)
    process.exitCode = 1
  })
}
