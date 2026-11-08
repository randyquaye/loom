import { writeFile } from 'node:fs/promises'
import { dialog } from 'electron'
import type { AgentEvent } from '../../shared/events'
import { eventsToMarkdown } from '../export/markdown'
import { slugify } from '../git/slug'
import { handle, type IpcDeps } from './handle'

interface SessionExportRow {
  title: string
  backend: string
  model: string
  effort: string
  created_at: number
}

export function registerExportIpc(deps: IpcDeps): void {
  handle('sessions:exportMarkdown', async ({ sessionId }) => {
    const session = deps.db
      .prepare('SELECT title, backend, model, effort, created_at FROM sessions WHERE id = ?')
      .get(sessionId) as SessionExportRow | undefined
    if (session === undefined) throw new Error(`unknown session ${sessionId}`)

    const rows = deps.db
      .prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ payload: string }>
    const events = rows.map((row) => JSON.parse(row.payload) as AgentEvent)

    const markdown = eventsToMarkdown(
      {
        title: session.title,
        backend: session.backend,
        model: session.model,
        effort: session.effort,
        createdAt: session.created_at
      },
      events
    )

    const { canceled, filePath } = await dialog.showSaveDialog({
      // Titles carry spaces now that the model names conversations; a file name must not.
      defaultPath: `${slugify(session.title)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (canceled || filePath === undefined) return null
    await writeFile(filePath, markdown, 'utf8')
    return filePath
  })
}
