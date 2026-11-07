import { deriveBlocks } from '../../shared/blocks'
import type { AgentEvent } from '../../shared/events'

export interface SessionMeta {
  title: string
  backend: string
  model: string
  effort: string
  createdAt: number
}

export function eventsToMarkdown(meta: SessionMeta, events: AgentEvent[]): string {
  const lines: string[] = [
    `# ${meta.title}`,
    '',
    `> ${meta.backend} · ${meta.model} · ${meta.effort} · ${new Date(meta.createdAt).toISOString()}`,
    ''
  ]
  for (const block of deriveBlocks(events)) {
    if (block.kind === 'user') {
      lines.push(`**you:** ${block.text}`, '')
    } else if (block.kind === 'text') {
      lines.push(block.text, '')
    } else if (block.kind === 'reasoning') {
      lines.push('<details><summary>reasoning</summary>', '', block.text, '', '</details>', '')
    } else if (block.kind === 'tool') {
      lines.push(
        `<details><summary>${block.name}${block.ok === false ? ' ✗' : ''}</summary>`,
        '',
        '```json',
        JSON.stringify(block.args, null, 2),
        '```',
        ''
      )
      if (block.output !== undefined) lines.push('```', block.output, '```', '')
      lines.push('</details>', '')
    } else if (block.kind === 'subagent') {
      const status = block.ok === undefined ? ' …' : block.ok ? '' : ' ✗'
      lines.push(`<details><summary>subagent: ${block.description}${status}</summary>`, '')
      if (block.prompt !== undefined) lines.push('**brief:**', '', block.prompt, '')
      if (block.report !== undefined) lines.push(block.report, '')
      lines.push('</details>', '')
    } else {
      lines.push(`> ⚠️ ${block.message}`, '')
    }
  }
  return lines.join('\n')
}
