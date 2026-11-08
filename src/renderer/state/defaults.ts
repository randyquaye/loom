import { create } from 'zustand'
import { BACKEND_IDS, EFFORTS, type BackendId, type Effort, type ModelDescriptor } from '../../shared/models'

const KEY = 'loom.defaults'
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
const DEFAULT_SPEECH_SPEED = 1
/** ElevenLabs' accepted voice_settings.speed range. */
export const SPEECH_SPEED_MIN = 0.7
export const SPEECH_SPEED_MAX = 1.2

/** One loadout slot: a concrete backend + model + effort a new session can start on. */
export interface LoadoutEntry {
  backend: BackendId
  model: string
  effort: Effort
}

function isBackend(v: unknown): v is BackendId {
  return typeof v === 'string' && (BACKEND_IDS as string[]).includes(v)
}

function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
}

export function sameEntry(a: LoadoutEntry, b: LoadoutEntry): boolean {
  return a.backend === b.backend && a.model === b.model && a.effort === b.effort
}

export function entryKey(e: LoadoutEntry): string {
  return `${e.backend}:${e.model}:${e.effort}`
}

function parseEntry(v: unknown): LoadoutEntry | null {
  if (typeof v !== 'object' || v === null) return null
  const { backend, model, effort } = v as Record<string, unknown>
  if (!isBackend(backend) || typeof model !== 'string' || model === '' || !isEffort(effort)) return null
  return { backend, model, effort }
}

function dedupe(entries: LoadoutEntry[]): LoadoutEntry[] {
  return entries.filter((e, i) => entries.findIndex((x) => sameEntry(x, e)) === i)
}

function clampSpeed(speed: number): number {
  return Math.min(SPEECH_SPEED_MAX, Math.max(SPEECH_SPEED_MIN, speed))
}

interface Saved {
  loadout: LoadoutEntry[]
  voiceId: string
  speechSpeed: number
}

/**
 * Parse defensively: localStorage outlives schema changes. Current shape is
 * { loadout: [...], voiceId, speechSpeed }; the older { primary, byBackend } (and the flat
 * per-backend map before it) migrate to a loadout with the primary backend's default first.
 * Per-backend "catalog default" (model null) entries have no concrete model to carry over and are dropped.
 */
function load(): Saved {
  const fallback = { loadout: [], voiceId: DEFAULT_VOICE_ID, speechSpeed: DEFAULT_SPEECH_SPEED }
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof raw !== 'object' || raw === null) return fallback
    const obj = raw as Record<string, unknown>
    const voiceId =
      typeof obj.voiceId === 'string' && obj.voiceId.trim() !== '' ? obj.voiceId.trim() : DEFAULT_VOICE_ID
    const speechSpeed =
      typeof obj.speechSpeed === 'number' && Number.isFinite(obj.speechSpeed)
        ? clampSpeed(obj.speechSpeed)
        : DEFAULT_SPEECH_SPEED
    if (Array.isArray(obj.loadout)) {
      return { loadout: dedupe(obj.loadout.flatMap((v) => parseEntry(v) ?? [])), voiceId, speechSpeed }
    }
    const map = (typeof obj.byBackend === 'object' && obj.byBackend !== null ? obj.byBackend : obj) as Record<
      string,
      unknown
    >
    const primary = isBackend(obj.primary) ? obj.primary : null
    const order = primary === null ? BACKEND_IDS : [primary, ...BACKEND_IDS.filter((b) => b !== primary)]
    const loadout = order.flatMap((backend) => {
      const entry = map[backend]
      if (typeof entry !== 'object' || entry === null) return []
      const { model, effort } = entry as Record<string, unknown>
      if (typeof model !== 'string' || model === '') return []
      return [{ backend, model, effort: isEffort(effort) ? effort : 'medium' }]
    })
    return { loadout, voiceId, speechSpeed }
  } catch {
    // Corrupt value: start with an empty loadout (the composer falls back to the catalog).
    return fallback
  }
}

function persist(saved: Saved): void {
  localStorage.setItem(KEY, JSON.stringify(saved))
}

/** Preferred effort when the model supports it, else the model's middle tier. */
export function fitEffort(efforts: Effort[], preferred: Effort | null): Effort {
  if (preferred !== null && efforts.includes(preferred)) return preferred
  return efforts[Math.floor(efforts.length / 2)] ?? 'medium'
}

/** With an empty loadout: the first catalog model, claude first (the historical default). */
const FALLBACK_ORDER: BackendId[] = ['claude', ...BACKEND_IDS.filter((b) => b !== 'claude')]

/**
 * What a new session starts on: the loadout's first entry, else the first catalog model.
 * An empty model id means the catalogs are still loading; the picker pill says so.
 */
export function initialChoice(
  loadout: LoadoutEntry[],
  modelsByBackend: Record<string, ModelDescriptor[]>
): LoadoutEntry {
  const head = loadout[0]
  if (head !== undefined) return head
  for (const backend of FALLBACK_ORDER) {
    const first = modelsByBackend[backend]?.[0]
    if (first !== undefined) return { backend, model: first.id, effort: fitEffort(first.efforts, null) }
  }
  return { backend: 'claude', model: '', effort: 'medium' }
}

interface DefaultsState {
  /** Ordered; the first entry is the default a new session starts on. */
  loadout: LoadoutEntry[]
  voiceId: string
  /** A blank ID restores the built-in voice. */
  setVoiceId(voiceId: string): void
  speechSpeed: number
  /** Clamped to ElevenLabs' range; blank or non-numeric input restores 1.0. */
  setSpeechSpeed(speed: string): void
  /** Append, ignoring an exact duplicate. */
  add(entry: LoadoutEntry): void
  remove(index: number): void
  move(from: number, to: number): void
  /** Put this choice first (moving it if already present). */
  makeDefault(entry: LoadoutEntry): void
}

/**
 * Saved model loadout and spoken voice and speed. The loadout is an ordered list of backend/model/effort
 * entries, several per backend allowed. The composer opens on loadout[0]; its picker can swap the
 * choice for one session without changing the loadout.
 */
export const useDefaults = create<DefaultsState>((set, get) => {
  const save = (patch: Partial<Saved>) => {
    const { loadout, voiceId, speechSpeed } = get()
    persist({ loadout, voiceId, speechSpeed, ...patch })
    set(patch)
  }
  const write = (loadout: LoadoutEntry[]) => save({ loadout })
  return {
    ...load(),
    setVoiceId: (value) => save({ voiceId: value.trim() || DEFAULT_VOICE_ID }),
    setSpeechSpeed: (value) => {
      const speed = value.trim() === '' ? NaN : Number(value)
      save({ speechSpeed: Number.isFinite(speed) ? clampSpeed(speed) : DEFAULT_SPEECH_SPEED })
    },
    add: (entry) => {
      if (get().loadout.some((e) => sameEntry(e, entry))) return
      write([...get().loadout, entry])
    },
    remove: (index) => write(get().loadout.filter((_, i) => i !== index)),
    move: (from, to) => {
      const next = [...get().loadout]
      const [item] = next.splice(from, 1)
      if (item === undefined || to < 0 || to > next.length) return
      next.splice(to, 0, item)
      write(next)
    },
    makeDefault: (entry) => write([entry, ...get().loadout.filter((e) => !sameEntry(e, entry))])
  }
})
