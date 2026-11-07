import { WeaveMark } from '../ui/WeaveMark'
import './chat.css'

const QUICK_PROMPTS = ['Summarize repo', 'Plan a change', 'Review diff'] as const

export function ChatEmptyState({ onPrompt }: { onPrompt?: ((text: string) => void) | undefined }) {
  return (
    <div className="empty-state chat-empty">
      <WeaveMark />
      <div className="empty-title">What should we build?</div>
      <div className="quick-chips">
        {QUICK_PROMPTS.map((prompt) => (
          <button key={prompt} className="chip" onClick={() => onPrompt?.(prompt)}>
            {prompt}
          </button>
        ))}
      </div>
      <div className="chat-empty-hint">Ask an agent below. File paths in replies open in the viewer.</div>
    </div>
  )
}
