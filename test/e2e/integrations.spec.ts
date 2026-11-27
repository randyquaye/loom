import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test, expect, _electron, type ElectronApplication, type Locator } from '@playwright/test'

const execFileAsync = promisify(execFile)

const OUT = path.join(__dirname, '../../.qwen/tmp/loom-integration-shots')
const PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'loom')
const PROJECT_NAME = 'cli'
/**
 * Public, small under a partial clone, and has open pull requests — so the PRs tab
 * renders real rows from a live `gh` call rather than an empty state.
 */
const FIXTURE_REMOTE = 'https://github.com/cli/cli.git'

test.setTimeout(180_000)

// The harness copies the live profile's database, so it needs one to copy.
test.skip(!existsSync(path.join(PROFILE, 'loom.db')), 'no seeded Loom profile to copy')

/**
 * Audits the GitHub and Linear surfaces against the real integrations. `gh` runs as a
 * subprocess and Linear as a main-process fetch, so neither is reachable by the browser
 * route blocker: what renders depends on this machine's credentials. The invariant
 * asserted throughout is therefore that every surface *resolves* — to rows, or to an
 * honest empty state naming its remedy — and never hangs on its loading copy.
 */
test('integration surfaces resolve against live GitHub and Linear', async () => {
  mkdirSync(OUT, { recursive: true })
  const profile = mkdtempSync(path.join(os.tmpdir(), 'loom-integrations-'))
  try {
    copyFileSync(path.join(PROFILE, 'loom.db'), path.join(profile, 'loom.db'))
    await seedFixtureProject(profile)

    const app: ElectronApplication = await _electron.launch({
      args: [
        path.join(__dirname, '../../out/main/index.js'),
        `--user-data-dir=${profile}`,
        '--disable-background-networking'
      ],
      env: { ...process.env, LOOM_DATA_DIR: profile }
    })
    try {
      // Renderer requests stay blocked; the integrations are main-process, so they run live.
      await app.context().route(/^https?:/, (route) => route.abort())
      const win = await app.firstWindow()

      const projectRow = win.locator('.project-row', { hasText: PROJECT_NAME }).first()
      await expect(projectRow, 'the seeded fixture project did not load').toBeVisible()
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '01-home.png') })

      await win.locator(`[aria-label="New workspace in ${PROJECT_NAME}"]`).click()
      await expect(win.locator('.nw-modal')).toBeVisible()

      await win.locator('.nw-chip').click()
      const popover = win.locator('.nw-integrations')
      await expect(popover).toBeVisible()
      const list = win.locator('.nw-list')

      // Branches reads the fixture clone's local git, with no network involved.
      await expect(win.getByRole('tab', { name: 'Branches' })).toHaveAttribute('aria-selected', 'true')
      await expect(list.locator('.nw-row', { hasText: 'trunk' }).first()).toBeVisible()

      await win.getByRole('tab', { name: 'PRs' }).click()
      await expect(win.getByRole('tab', { name: 'PRs' })).toHaveAttribute('aria-selected', 'true')
      await expect
        .poll(() => settledState(list), { timeout: 60000, message: 'the PRs tab never settled' })
        .not.toBe('loading')
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02-prs-tab.png') })

      // cli/cli has open PRs and gh is authenticated here, so rows are the expected case.
      // When they are present, the row anatomy is asserted; when this machine cannot reach
      // GitHub the honest empty state above already passed, so the run stays meaningful.
      const prRows = list.locator('.nw-row')
      if ((await prRows.count()) > 0) {
        const first = prRows.first()
        await expect(first.locator('.nw-pr-number')).toHaveText(/^#\d+$/)
        await expect(first.locator('.nw-pr-title')).toBeVisible()
        await expect(first.locator('.nw-pr-refs')).toContainText('→')
        // Picking a PR sets the base ref to its head branch, and only that.
        await first.click()
        await expect(popover).toHaveCount(0)
        const chipLabel = await win.locator('.nw-chip .nw-chip-label').textContent()
        expect(chipLabel?.trim(), 'the chip should show the picked PR head branch').not.toBe('Default branch')
        await win.screenshot({ animations: 'disabled', path: path.join(OUT, '03-pr-picked.png') })
        await win.locator('.nw-chip').click()
      }

      await win.getByRole('tab', { name: 'Issues' }).click()
      await expect
        .poll(() => settledState(list), { timeout: 60000, message: 'the Issues tab never settled' })
        .not.toBe('loading')
      const issueState = await settledState(list)
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '04-issues-tab.png') })
      // No Linear key is seeded, so this must say so and offer the way out.
      if (issueState !== 'rows') {
        await expect(list.locator('.nw-empty')).toContainText(/Linear API key/)
        await expect(list.getByRole('button', { name: 'Open Settings' })).toBeVisible()
      }

      await win.keyboard.press('Escape')
      await win.waitForTimeout(200)
      await win.keyboard.press('Escape')
      await win.waitForTimeout(300)

      await win.getByText('Settings', { exact: true }).first().click()
      const integrations = win.getByText('Integrations', { exact: true }).first()
      await expect(integrations).toBeVisible()
      await integrations.scrollIntoViewIfNeeded()
      await win.waitForTimeout(300)

      for (const name of ['github', 'linear']) {
        const row = win
          .locator('.settings-row', { has: win.locator('.settings-name', { hasText: name }) })
          .first()
        await expect(row, `no ${name} row in Settings → Integrations`).toBeVisible()
        await expect(row.locator('.settings-state')).not.toHaveText('Checking…', { timeout: 60000 })
      }
      // gh is installed and signed in on this machine, so the account must be shown.
      const githubRow = win
        .locator('.settings-row', { has: win.locator('.settings-name', { hasText: 'github' }) })
        .first()
      await expect(githubRow.locator('.settings-state')).toHaveText('Ready')
      await expect(githubRow.locator('.settings-mask')).not.toHaveText('')
      await expect(
        win
          .locator('.settings-row', { has: win.locator('.settings-name', { hasText: 'linear' }) })
          .first()
          .locator('.settings-state')
      ).toHaveText('API key required')
      await win.screenshot({
        animations: 'disabled',
        path: path.join(OUT, '05-settings-integrations.png')
      })

      // The key editor must be a modal, never an inline field, and cancelling must store nothing.
      const linearRow = win
        .locator('.settings-row', { has: win.locator('.settings-name', { hasText: 'linear' }) })
        .first()
      await linearRow.getByRole('button', { name: 'Add' }).click()
      const keyModal = win.locator('.modal', { hasText: 'Linear API key' })
      await expect(keyModal).toBeVisible()
      await expect(keyModal.locator('input[type="password"]')).toBeVisible()
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '06-linear-key-modal.png') })
      await win.keyboard.press('Escape')
      await win.waitForTimeout(300)
      await expect(keyModal).toHaveCount(0)
      await expect(linearRow.locator('.settings-state')).toHaveText('API key required')
    } finally {
      await app.close()
    }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

/**
 * What the picker list is showing. `loading` and `closed` are told apart deliberately: the
 * loading state also uses `.nw-empty`, so only its copy distinguishes them, and a popover
 * that has closed would otherwise be indistinguishable from a surface that never resolved.
 */
async function settledState(list: Locator): Promise<'rows' | 'empty' | 'error' | 'loading' | 'closed'> {
  if ((await list.count()) === 0) return 'closed'
  if ((await list.locator('.nw-row').count()) > 0) return 'rows'
  if ((await list.locator('.error-state').count()) > 0) return 'error'
  const texts = await list.locator('.nw-empty').allTextContents()
  if (texts.some((text) => /Loading/.test(text))) return 'loading'
  return texts.length > 0 ? 'empty' : 'closed'
}

/**
 * Clones a partial copy of a public repo into the temp profile and registers it as a
 * project. Only the temp copy of the database is written; the live profile is untouched.
 * A partial clone is enough because the audit reads refs and the GitHub remote, not blobs.
 */
async function seedFixtureProject(profile: string): Promise<void> {
  const repoPath = path.join(profile, 'fixture-repo')
  await execFileAsync(
    'git',
    ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--', FIXTURE_REMOTE, repoPath],
    { shell: false }
  )
  const dbPath = path.join(profile, 'loom.db')
  // better-sqlite3 is rebuilt for Electron's ABI, so the row goes in through the sqlite3 CLI.
  const sql =
    `INSERT INTO projects (id, name, repo_path, remote_url, created_at) ` +
    `VALUES ('fixture-cli', '${PROJECT_NAME}', '${repoPath}', '${FIXTURE_REMOTE}', ${Date.now()});`
  await execFileAsync('sqlite3', [dbPath, sql], { shell: false })
}
