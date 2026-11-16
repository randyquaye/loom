import { ChatMarkdown } from '../chat/ChatMarkdown'

export function MarkdownView({
  text,
  onOpen,
  workspaceId
}: {
  text: string
  onOpen: (path: string, line?: number) => void
  workspaceId?: string
}) {
  return (
    <div className="md-view">
      <ChatMarkdown text={text} onFileOpen={onOpen} workspaceId={workspaceId} />
    </div>
  )
}
