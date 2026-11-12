import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import * as pty from 'node-pty'
import { LOGIN_FILES } from '../../shared/login-files'
import dockerDefaultSeccomp from './docker-default-seccomp.json'
import { collect } from './exec'
import type { ProcessOpts, WorkspaceRuntime } from './types'

const execFileAsync = promisify(execFile)

export interface ContainerSpec {
  /** Unique per workspace: Docker refuses a second container with the same name. */
  name: string
  image: string
  /** Mounted at this same path inside, so a file path means one thing to runner and agent. */
  checkoutPath: string
  /** Host folder mounted as the container user's home; agent logins and conversations live here. */
  homePath: string
  /** Sources outside the mounted home, updated only by the runner. */
  loginFilesPath?: string
  /** Where the container's syscall filter is written before each start. */
  seccompProfilePath: string
  /**
   * An AppArmor profile loaded on the host, for hosts whose default one refuses the mounts
   * Codex's sandbox makes. Left out, Docker applies its own, or none where there is no AppArmor.
   */
  apparmorProfile?: string
  /** Names the container resolves to given addresses, as `name:address`. */
  hosts?: readonly string[]
  /** Runs on the home folder before each start, after Loom's own files are in place. */
  secureHome?(homePath: string): Promise<void>
  memory: string
  cpus: string
}

const CONTAINER_HOME = '/home/loom'
const TERMINAL_NAME = 'xterm-256color'
const KILL_GRACE_SECONDS = 2

/**
 * A process id alone does not say which process it names: ids are reused. The record is the
 * id plus the process's start time, which no later process can share. The start time is the
 * 22nd field of /proc/PID/stat; the name in field 2 may contain spaces, so it is cut off first.
 */
const START_TIME = `sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20`

/**
 * A workspace's variables reach `docker exec` through the environment of the docker program
 * itself, which runs on the host. Under their own names they would speak to that program
 * and to the system loading it: a variable that loads a library, or points at another
 * daemon, would act on the host, outside every container. So each travels under this prefix,
 * which means nothing to anything on the host, and is given its own name once inside.
 */
const ENV_PREFIX = 'LOOMENV_'
/** A name is spliced into the launcher's shell; nothing but a plain variable name may be. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Gives the variables their own names, records who it is where `STOP` will look, then
 * becomes the command. $1 is how many variable names follow it. A value is never read as
 * shell: it is only ever copied from one variable to another. A stop that arrived first
 * leaves a marker, and a launcher that finds it never starts the command at all.
 */
const LAUNCH = [
  'n=$1; shift',
  `while [ "$n" -gt 0 ]; do eval "export $1=\\"\\\${${ENV_PREFIX}$1}\\""; unset "${ENV_PREFIX}$1"; shift; n=$((n - 1)); done`,
  `started() { ${START_TIME}; }`,
  'cancelled() { [ -e "$0.cancel" ] && rm -f "$0" "$0.cancel"; }',
  'cancelled && exit 143',
  'echo "$$ $(started $$)" > "$0"',
  'cancelled && exit 143',
  'exec "$@"'
].join('\n')

/**
 * Stopping the local `docker exec` leaves its process running in the container, so every stop
 * is delivered from inside. A process started by `docker exec` leads its own process group,
 * which makes its id the handle for its whole tree. $0 is the record, $1 the first signal,
 * $2 the grace period in seconds. The stop is refused unless the record still names the
 * process it was written by.
 */
const STOP = [
  `started() { ${START_TIME}; }`,
  ': > "$0.cancel"',
  'i=0; while [ ! -s "$0" ] && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done',
  // No record yet: the marker stays, for a launcher that has not got this far.
  'read -r pid start < "$0" 2>/dev/null || exit 0',
  'rm -f "$0" "$0.cancel"',
  '[ -n "$start" ] && [ "$(started "$pid")" = "$start" ] || exit 0',
  'kill "-$1" "-$pid" 2>/dev/null || exit 0',
  'i=0; while [ "$(started "$pid")" = "$start" ] && [ "$i" -lt $(($2 * 10)) ]; do sleep 0.1; i=$((i + 1)); done',
  '[ "$(started "$pid")" = "$start" ] && kill -KILL "-$pid" 2>/dev/null',
  'exit 0'
].join('\n')

/**
 * Codex confines the commands it runs with a sandbox it builds from Linux namespaces, and
 * Docker's default syscall filter refuses the calls that takes. Without them the sandbox
 * cannot start and Codex has to ask the user before every command. These five are the
 * smallest set it starts with. They grant no privilege: the kernel still only honours them
 * inside a namespace the calling process itself created.
 */
const NESTED_SANDBOX_SYSCALLS = ['unshare', 'clone', 'mount', 'umount2', 'pivot_root']

/**
 * Docker's default filter, exactly as Docker publishes it, plus the rule above. Docker has
 * no way to say "the default and these", so the whole filter is supplied. The copy is
 * refreshed with `pnpm update-seccomp`.
 */
export function workspaceSeccompProfile(): object {
  return {
    ...dockerDefaultSeccomp,
    syscalls: [...dockerDefaultSeccomp.syscalls, { names: NESTED_SANDBOX_SYSCALLS, action: 'SCMP_ACT_ALLOW' }]
  }
}

/**
 * What a new cloud home starts with. Codex otherwise treats the checkout as untrusted. With
 * this its own sandbox keeps commands to the checkout and it asks before going further,
 * as it does on a laptop. The file is the user's to edit and is never overwritten.
 */
const CODEX_HOME_DEFAULTS = 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n'

/** Docker would create a missing mount source as root; the runner creates it as itself. */
async function prepareHome(homePath: string): Promise<void> {
  await mkdir(path.join(homePath, '.codex'), { recursive: true })
  // An empty home makes zsh open its first-run questionnaire in every new terminal.
  await writeFile(path.join(homePath, '.zshrc'), '', { flag: 'a' })
  await writeFile(path.join(homePath, '.codex', 'config.toml'), CODEX_HOME_DEFAULTS, { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    }
  )
}

/** A mount spec is comma separated, so a path containing one cannot be expressed safely. */
function bindMount(source: string, target: string): string {
  if (source.includes(',') || target.includes(',')) {
    throw new Error(`a container cannot mount a path that contains a comma: ${source}`)
  }
  return `type=bind,source=${source},target=${target}`
}

export const containerArgs = {
  /** The main process only idles; --init reaps what the stopped process trees leave behind. */
  run(spec: ContainerSpec): string[] {
    return [
      'run',
      '--detach',
      '--init',
      '--name',
      spec.name,
      '--memory',
      spec.memory,
      '--cpus',
      spec.cpus,
      // No Docker socket is mounted, and nothing inside can gain privileges it did not start with.
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      '--security-opt',
      `seccomp=${spec.seccompProfilePath}`,
      ...(spec.apparmorProfile === undefined ? [] : ['--security-opt', `apparmor=${spec.apparmorProfile}`]),
      ...(spec.hosts ?? []).flatMap((host) => ['--add-host', host]),
      '--mount',
      bindMount(spec.checkoutPath, spec.checkoutPath),
      '--mount',
      bindMount(spec.homePath, CONTAINER_HOME),
      ...(spec.loginFilesPath === undefined
        ? []
        : LOGIN_FILES.flatMap((relative) => [
            '--mount',
            `${bindMount(path.join(spec.loginFilesPath!, relative), path.join(CONTAINER_HOME, relative))},readonly`
          ])),
      spec.image
    ]
  },

  /**
   * Starts `command` in the container through the launcher, which records itself in
   * `idFile`. Variables are passed by name only: `docker exec -e NAME` copies the value from
   * the docker program's own environment, which keeps secrets out of argv.
   */
  exec(name: string, opts: ProcessOpts, idFile: string, command: readonly string[], tty = false): string[] {
    const names = Object.keys(opts.env ?? {})
    const odd = names.find((key) => !VARIABLE_NAME.test(key))
    if (odd !== undefined) {
      throw new Error(`"${odd}" cannot be passed into a container workspace: it is not a variable name`)
    }
    return [
      'exec',
      tty ? '-it' : '-i',
      ...(opts.cwd === undefined ? [] : ['-w', opts.cwd]),
      ...names.flatMap((key) => ['-e', `${ENV_PREFIX}${key}`]),
      name,
      'sh',
      '-c',
      LAUNCH,
      idFile,
      String(names.length),
      ...names,
      ...command
    ]
  }
}

/** The docker program's environment: Loom's own, plus the workspace's variables under the prefix. */
export function clientEnvironment(env: Record<string, string> | undefined): Record<string, string> {
  const carried = Object.entries(env ?? {}).map(([name, value]) => [`${ENV_PREFIX}${name}`, value])
  return { ...process.env, ...Object.fromEntries(carried) } as Record<string, string>
}

async function docker(args: readonly string[]): Promise<string> {
  try {
    return (await execFileAsync('docker', [...args], { shell: false })).stdout
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new Error(`docker ${args[0]} failed: ${stderr || String(error)}`, { cause: error })
  }
}

/**
 * Which running container sits at which address on the Docker networks, as Docker says now.
 * `prefix` picks containers by the start of their name.
 */
export async function containerAddresses(prefix: string): Promise<Map<string, string>> {
  const ids = (await docker(['ps', '--quiet', '--filter', `name=^${prefix}`])).split('\n').filter(Boolean)
  const found = new Map<string, string>()
  if (ids.length === 0) return found
  const listed = await docker([
    'inspect',
    '--format',
    '{{.Name}}\t{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
    ...ids
  ])
  for (const line of listed.split('\n')) {
    const [name, addresses] = line.split('\t')
    if (name === undefined || addresses === undefined) continue
    for (const address of addresses.split(' ').filter(Boolean)) found.set(address, name.replace(/^\//, ''))
  }
  return found
}

/** Removes every container, running or not, whose name starts with `prefix`. */
export async function removeContainersNamed(prefix: string): Promise<void> {
  const ids = (await docker(['ps', '--all', '--quiet', '--filter', `name=^${prefix}`]))
    .split('\n')
    .filter(Boolean)
  if (ids.length > 0) await docker(['rm', '--force', ...ids])
}

/** `rm --force` also succeeds when the container is already gone. */
export async function removeContainer(name: string): Promise<void> {
  await docker(['rm', '--force', name])
}

/** Runs everything a workspace executes inside that workspace's own container. */
export function createContainerRuntime(spec: ContainerSpec): WorkspaceRuntime {
  /** Starts and stops take turns, so a stop can never be overtaken by the start before it. */
  let lifecycle: Promise<void> = Promise.resolve()

  function inTurn(step: () => Promise<void>): Promise<void> {
    const next = lifecycle.catch(() => undefined).then(step)
    lifecycle = next
    return next
  }

  async function start(): Promise<void> {
    const running = await docker(['inspect', '--format', '{{.State.Running}}', spec.name]).catch(() => null)
    if (running?.trim() === 'true') return
    await prepareHome(spec.homePath)
    await spec.secureHome?.(spec.homePath)
    await writeFile(spec.seccompProfilePath, JSON.stringify(workspaceSeccompProfile()))
    if (running !== null) await removeContainer(spec.name)
    await docker(containerArgs.run(spec))
  }

  function newIdFile(): string {
    return `/tmp/loom-proc-${randomUUID()}.pid`
  }

  function stopInside(idFile: string, signal: 'TERM' | 'HUP'): void {
    const stopper = spawn(
      'docker',
      ['exec', spec.name, 'sh', '-c', STOP, idFile, signal, String(KILL_GRACE_SECONDS)],
      { stdio: 'ignore', shell: false }
    )
    stopper.on('error', () => {})
    // The stop finishes on its own even when the runner is already shutting down.
    stopper.unref()
  }

  return {
    ensureRunning() {
      // One at a time: two tabs opening together must not race each other to `docker run`.
      return inTurn(start)
    },

    exec(file, args, opts = {}) {
      return collect(this.spawn(file, args, opts), file, opts)
    },

    spawn(file, args, opts = {}) {
      const idFile = newIdFile()
      const child = spawn('docker', containerArgs.exec(spec.name, opts, idFile, [file, ...args]), {
        shell: false,
        env: clientEnvironment(opts.env),
        stdio: ['pipe', 'pipe', 'pipe']
      })
      // Asked for even when the local client is already gone: the process may have outlived it.
      return { child, terminate: () => stopInside(idFile, 'TERM') }
    },

    openTerminal(opts = {}) {
      const idFile = newIdFile()
      const env = { ...opts.env, TERM: TERMINAL_NAME }
      const terminal = pty.spawn(
        'docker',
        containerArgs.exec(spec.name, { ...opts, env }, idFile, ['zsh'], true),
        { name: TERMINAL_NAME, cols: 80, rows: 24, env: clientEnvironment(env) }
      )
      return { pty: terminal, terminate: () => stopInside(idFile, 'HUP') }
    },

    stop() {
      return inTurn(() => removeContainer(spec.name))
    }
  }
}
