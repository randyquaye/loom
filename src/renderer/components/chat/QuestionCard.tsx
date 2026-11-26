import { useRef, useState, type FormEvent } from 'react'
import type { QuestionRequest } from '../../../shared/events'
import { useUi } from '../../state/ui'
import { ErrorRow } from './MessageBlocks'
import './questions.css'

type Question = QuestionRequest['questions'][number]

export function QuestionCard({
  request,
  sessionId,
  disabled,
  followUp = false,
  readOnly = false
}: {
  request: QuestionRequest
  sessionId: string | undefined
  disabled: boolean
  followUp?: boolean
  readOnly?: boolean
}) {
  const draftKey = `${sessionId}:${request.requestId}`
  const draft = useUi.getState().questionDrafts[draftKey]
  // Option indexes as strings, per question; typed text is a separate answer source.
  const [selected, setSelected] = useState<Record<string, string[]>>(() => draft?.selected ?? {})
  const [text, setText] = useState<Record<string, string>>(() => draft?.text ?? {})
  const [status, setStatus] = useState<'idle' | 'sending' | 'submitted'>('idle')
  const [error, setError] = useState('')
  const waiting = useRef(false)

  const answers = Object.fromEntries(
    request.questions.map((question) => {
      const picked = (selected[question.id] ?? []).flatMap(
        (index) => question.options?.[Number(index)]?.label ?? []
      )
      const typed = text[question.id] ?? ''
      return [question.id, typed.trim() ? [...picked, typed] : picked]
    })
  )
  const ready = Object.values(answers).every((values) => values.length > 0)

  function save(nextSelected: Record<string, string[]>, nextText: Record<string, string>): void {
    setSelected(nextSelected)
    setText(nextText)
    useUi.getState().saveQuestionDraft(draftKey, { selected: nextSelected, text: nextText })
  }

  // Single-select: a picked option and typed text are mutually exclusive answers.
  function pick(question: Question, index: string): void {
    const current = selected[question.id] ?? []
    if (!question.multiSelect)
      return save({ ...selected, [question.id]: [index] }, { ...text, [question.id]: '' })
    const next = current.includes(index) ? current.filter((value) => value !== index) : [...current, index]
    save({ ...selected, [question.id]: next }, text)
  }

  function type(question: Question, value: string): void {
    const clear = !question.multiSelect && value.trim() !== ''
    save(clear ? { ...selected, [question.id]: [] } : selected, { ...text, [question.id]: value })
  }

  const locked = readOnly || disabled || !sessionId || status !== 'idle'
  let submitLabel = 'Submit answer'
  if (request.purpose === 'approval') submitLabel = 'Submit approval'
  if (followUp) submitLabel = 'Send follow-up'
  if (status === 'sending') submitLabel = 'Sending…'
  if (disabled) submitLabel = 'Closed'
  if (readOnly) submitLabel = 'View only'

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (locked || waiting.current || !ready || sessionId === undefined) return
    waiting.current = true
    setStatus('sending')
    setError('')
    try {
      await window.loom.sessions.answerQuestion(sessionId, { requestId: request.requestId, answers })
      useUi.getState().saveQuestionDraft(draftKey, null)
      setStatus('submitted')
    } catch (error) {
      setError(String(error))
      setStatus('idle')
    } finally {
      waiting.current = false
    }
  }

  if (status === 'submitted') return null
  return (
    <form className="chat-question" onSubmit={(event) => void submit(event)}>
      {request.questions.map((question) => {
        const hasOptions = !!question.options?.length
        return (
          <fieldset key={question.id} disabled={locked}>
            {question.header && <legend>{question.header}</legend>}
            <p>{question.question}</p>
            {hasOptions && (
              <div className="chat-question-options">
                {question.options?.map((option, index) => (
                  <label key={index} className="chat-question-choice">
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={`${request.requestId}:${question.id}`}
                      checked={selected[question.id]?.includes(String(index)) ?? false}
                      onChange={() => pick(question, String(index))}
                    />
                    <span className="chat-question-mark" aria-hidden="true" />
                    <span className="chat-question-choice-body">
                      <span>{option.label}</span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {(question.isOther || !hasOptions) && (
              <input
                className="input"
                aria-label={hasOptions ? `Other answer: ${question.question}` : question.question}
                placeholder={hasOptions ? 'Type something else…' : 'Type your answer…'}
                autoComplete="off"
                type={question.isSecret ? 'password' : 'text'}
                value={text[question.id] ?? ''}
                onChange={(event) => type(question, event.target.value)}
              />
            )}
          </fieldset>
        )
      })}
      {error && <ErrorRow message={error} />}
      <button className="btn btn-primary" disabled={locked || !ready}>
        {submitLabel}
      </button>
    </form>
  )
}
