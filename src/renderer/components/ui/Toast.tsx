import { create } from 'zustand'

interface Toast {
  id: number
  text: string
  kind: 'ok' | 'err'
}

interface ToastState {
  toasts: Toast[]
  push(text: string, kind?: 'ok' | 'err'): void
  dismiss(id: number): void
}

let nextId = 1

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(text, kind = 'ok') {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200)
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

export function ToastViewport() {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div className="toast-viewport">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={`toast glass toast-${t.kind}`}
          onClick={() => useToasts.getState().dismiss(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}
