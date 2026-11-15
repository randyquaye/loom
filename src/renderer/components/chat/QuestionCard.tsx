import { useRef, useState, type FormEvent } from 'react'
import type { QuestionAnswer, QuestionRequest } from '../../../shared/events'
import { useUi } from '../../state/ui'
import { ErrorRow } from './MessageBlocks'
import './questions.css'

export function QuestionCard({
  request,
  sessionId,
  disabled,
  answers: savedAnswers,
  followUp = false,
  readOnly = false
}: {
  request: QuestionRequest
  sessionId: string | undefined
  disabled: boolean
  answers?: QuestionAnswer['answers'] | undefined
  followUp?: boolean
  readOnly?: boolean
}) {
  const draftKey = `${sessionId}:${request.requestId}`
  const [selected, setSelected] = useState<Record<string, string[]>>(
    () =>
      useUi.getState().questionDrafts[draftKey]?.selected ??
      Object.fromEntries(
        request.questions.map((question) => {
          const values = savedAnswers?.[question.id] ?? []
          return [
            question.id,
            values.map((value) => {
              const index = question.options?.findIndex((option) => option.label === value) ?? -1
              return index < 0 ? 'other' : String(index)
            })
          ]
        })
      )
  )
  const [text, setText] = useState<Record<string, string>>(
    () =>
      useUi.getState().questionDrafts[draftKey]?.text ??
      Object.fromEntries(Object.entries(savedAnswers ?? {}).map(([id, values]) => [id, values.join(', ')]))
  )
  const [status, setStatus] = useState<'idle' | 'sending' | 'submitted'>('idle')
  const [error, setError] = useState('')
  const waiting = useRef(false)
  const answers = Object.fromEntries(
    request.questions.map((question) => {
      const values = !question.options?.length
        ? [text[question.id] ?? '']
        : (selected[question.id] ?? []).map((choice) =>
            choice === 'other' ? (text[question.id] ?? '') : (question.options?.[Number(choice)]?.label ?? '')
          )
      return [question.id, values]
    })
  )
  const ready = Object.values(answers).every(
    (values) => values.length > 0 && values.every((value) => value.trim())
  )
  function select(question: QuestionRequest['questions'][number], choice: string) {
    const current = selected[question.id] ?? []
    const next = question.multiSelect
      ? current.includes(choice)
        ? current.filter((value) => value !== choice)
        : [...current, choice]
      : [choice]
    const updated = { ...selected, [question.id]: next }
    setSelected(updated)
    useUi.getState().saveQuestionDraft(draftKey, { selected: updated, text })
  }
  const locked = readOnly || disabled || savedAnswers !== undefined || !sessionId || status !== 'idle'
  let submitLabel = 'Submit answer'
  if (request.purpose === 'approval') submitLabel = 'Submit approval'
  if (followUp) submitLabel = 'Send follow-up'
  if (status === 'sending') submitLabel = 'Sending…'
  if (disabled) submitLabel = 'Closed'
  if (readOnly) submitLabel = 'View only'
  if (status === 'submitted') submitLabel = 'Submitted'
  if (savedAnswers !== undefined) submitLabel = 'Submitted'

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

  if (status === 'submitted' || savedAnswers !== undefined) return null
  return (
    <form className="chat-question" onSubmit={(event) => void submit(event)}>
      {request.questions.map((question) => (
        <fieldset key={question.id} disabled={locked}>
          {question.header && <legend>{question.header}</legend>}
          <p>{question.question}</p>
          {!!question.options?.length && (
            <div className="chat-question-options">
              {question.options.map((option, index) => (
                <label key={index} className="chat-question-choice" data-disabled={locked}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={`${request.requestId}:${question.id}`}
                    checked={selected[question.id]?.includes(String(index)) ?? false}
                    onChange={() => select(question, String(index))}
                  />
                  <span className="btn chat-question-choice-body">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              {question.isOther && (
                <label className="chat-question-choice" data-disabled={locked}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={`${request.requestId}:${question.id}`}
                    checked={selected[question.id]?.includes('other') ?? false}
                    onChange={() => select(question, 'other')}
                  />
                  <span className="btn chat-question-choice-body">Other</span>
                </label>
              )}
            </div>
          )}
          {(!question.options?.length || selected[question.id]?.includes('other')) && (
            <input
              className="input"
              aria-label={question.question}
              autoComplete="off"
              type={question.isSecret ? 'password' : 'text'}
              value={text[question.id] ?? ''}
              onChange={(event) => {
                const updated = { ...text, [question.id]: event.target.value }
                setText(updated)
                useUi.getState().saveQuestionDraft(draftKey, { selected, text: updated })
              }}
            />
          )}
        </fieldset>
      ))}
      {error && <ErrorRow message={error} />}
      <button className="btn btn-primary" disabled={locked || !ready}>
        {submitLabel}
      </button>
    </form>
  )
}
