import { useEffect, useState } from 'react'
import { BACKEND_IDS, type BackendId, type Effort } from '../../shared/models'
import { Dropdown } from '../components/ui/Dropdown'
import { ErrorState } from '../components/ui/ErrorState'
import { entryKey, fitEffort, sameEntry, useDefaults, type LoadoutEntry } from '../state/defaults'
import { useSessions } from '../state/sessions'

/** Dropdown values join backend and model id; backend ids never contain '/', model ids may. */
function optionValue(backend: BackendId, model: string): string {
  return `${backend}/${model}`
}

function parseOption(value: string): { backend: BackendId; model: string } | null {
  const slash = value.indexOf('/')
  const backend = BACKEND_IDS.find((b) => b === value.slice(0, slash))
  return backend === undefined ? null : { backend, model: value.slice(slash + 1) }
}

/**
 * Settings "Default models": an ordered loadout of backend/model/effort entries, several per
 * backend allowed. The first entry is the default a new session starts on; it is marked
 * inline (position + a small tag) so the list stays aligned. Reorder by dragging a row or
 * with its up/down buttons; add with the two dropdowns below; remove per entry.
 */
export function Loadout() {
  const loadout = useDefaults((s) => s.loadout)
  const add = useDefaults((s) => s.add)
  const remove = useDefaults((s) => s.remove)
  const move = useDefaults((s) => s.move)
  const modelsByBackend = useSessions((s) => s.modelsByBackend)
  const modelErrorByBackend = useSessions((s) => s.modelErrorByBackend)
  const loadModels = useSessions((s) => s.loadModels)
  const retryModels = useSessions((s) => s.retryModels)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [pick, setPick] = useState('')
  const [pickEffort, setPickEffort] = useState<Effort | null>(null)

  useEffect(() => {
    for (const b of BACKEND_IDS) void loadModels(b)
  }, [loadModels])

  const options = BACKEND_IDS.flatMap((b) =>
    (modelsByBackend[b] ?? []).map((m) => ({ value: optionValue(b, m.id), label: `${b} · ${m.label}` }))
  )
  const selected = options.some((o) => o.value === pick) ? pick : (options[0]?.value ?? '')
  const parsed = parseOption(selected)
  const descriptor =
    parsed === null ? undefined : modelsByBackend[parsed.backend]?.find((m) => m.id === parsed.model)
  const efforts = descriptor?.efforts ?? []
  const candidate: LoadoutEntry | null =
    parsed === null || descriptor === undefined ? null : { ...parsed, effort: fitEffort(efforts, pickEffort) }
  const duplicate = candidate !== null && loadout.some((e) => sameEntry(e, candidate))
  const failed = BACKEND_IDS.filter((b) => modelErrorByBackend[b] !== undefined)

  function labelOf(e: LoadoutEntry): string {
    return modelsByBackend[e.backend]?.find((m) => m.id === e.model)?.label ?? e.model
  }

  function endDrag() {
    setDragFrom(null)
    setDragOver(null)
  }

  return (
    <section className="settings-section">
      <div className="settings-label">Default models</div>
      <p className="settings-note">
        Your loadout. New sessions start on the first entry; drag a row or use its arrows to reorder. The
        composer&apos;s model picker can swap model and effort for one session without changing this list.
      </p>

      <ol className="settings-list loadout-list" aria-label="Model loadout">
        {loadout.map((entry, i) => {
          const label = labelOf(entry)
          return (
            <li
              key={entryKey(entry)}
              className="settings-row loadout-row"
              draggable
              data-dragging={dragFrom === i}
              data-over={dragOver === i && dragFrom !== i}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', String(i))
                setDragFrom(i)
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOver(i)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom !== null && dragFrom !== i) move(dragFrom, i)
                endDrag()
              }}
              onDragEnd={endDrag}
            >
              <span className="loadout-grip" aria-hidden="true">
                ⠿
              </span>
              <span className="loadout-pos">{i + 1}</span>
              <span className={`provider-dot provider-${entry.backend}`} aria-hidden="true" />
              <span className="loadout-model">{label}</span>
              {i === 0 && (
                <span className="loadout-default" title="New sessions start here">
                  default
                </span>
              )}
              <span className="loadout-meta grow">
                {entry.backend} · {entry.effort}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Move ${label} (${entry.effort}) up`}
                title="Move up"
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Move ${label} (${entry.effort}) down`}
                title="Move down"
                disabled={i === loadout.length - 1}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${label} (${entry.effort})`}
                title="Remove"
                onClick={() => remove(i)}
              >
                ×
              </button>
            </li>
          )
        })}
        {loadout.length === 0 && (
          <li className="settings-row loadout-empty">
            No models yet. New sessions start on the first available model until you add one.
          </li>
        )}
      </ol>

      {failed.length > 0 && (
        <ErrorState
          compact
          title={`Couldn’t load ${failed.join(', ')} models`}
          detail={failed.map((b) => modelErrorByBackend[b]).join('\n')}
          onRetry={() => {
            for (const b of failed) void retryModels(b)
          }}
        />
      )}

      <div className="loadout-add">
        <div className="loadout-add-model">
          <Dropdown value={selected} options={options} placeholder="Loading models…" onChange={setPick} />
        </div>
        <div className="loadout-add-effort">
          <Dropdown
            value={candidate?.effort ?? ''}
            options={efforts.map((e) => ({ value: e, label: e }))}
            placeholder="Effort"
            onChange={(v) => setPickEffort(efforts.find((e) => e === v) ?? null)}
          />
        </div>
        <button
          type="button"
          className="btn"
          disabled={candidate === null || duplicate}
          title={duplicate ? 'Already in the loadout' : 'Add to the end of the loadout'}
          onClick={() => {
            if (candidate !== null) add(candidate)
          }}
        >
          Add
        </button>
      </div>
    </section>
  )
}
