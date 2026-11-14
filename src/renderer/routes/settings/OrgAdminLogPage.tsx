import { useEffect, useRef, useState } from 'react'
import type { OrgAdminEvent, OrgMember } from '../../../shared/org'
import { useToasts } from '../../components/ui/Toast'
import { useOrganization } from '../../state/organization'

const ACTION_NAMES: Record<string, string> = {
  'org.create': 'Organization created',
  'org.rename': 'Organization renamed',
  'member.role': 'Member role changed',
  'member.remove': 'Member removed',
  'member.join': 'Member joined',
  'member.purge': 'Removed member’s files deleted',
  'member.purge.start': 'Member file deletion started',
  'member.purge.failed': 'Member file deletion failed',
  'invite.create': 'Invite created',
  'invite.revoke': 'Invite revoked'
}

export function OrgAdminLogPage() {
  const owner = useOrganization((state) => state.overview?.role === 'owner')
  const connection = useOrganization((state) => state.connection)
  const push = useToasts((state) => state.push)
  const [log, setLog] = useState<OrgAdminEvent[]>([])
  const [members, setMembers] = useState<OrgMember[]>([])
  const [busy, setBusy] = useState(false)
  const [hasOlder, setHasOlder] = useState(false)
  const request = useRef(0)

  useEffect(() => {
    const mine = ++request.current
    setLog([])
    setMembers([])
    setBusy(false)
    setHasOlder(false)
    if (owner)
      void Promise.all([window.loom.org.log(), window.loom.org.members()])
        .then(([entries, people]) => {
          if (mine !== request.current) return
          setLog(entries)
          setMembers(people)
          setHasOlder(entries.length === 100)
        })
        .catch((failure: unknown) => {
          if (mine === request.current) push(String(failure), 'err')
        })
    return () => {
      request.current++
    }
  }, [connection, owner, push])

  async function loadOlder() {
    const mine = ++request.current
    setBusy(true)
    try {
      const entries = await window.loom.org.log(log.at(-1)?.id)
      if (mine !== request.current) return
      setLog((previous) => previous.concat(entries))
      setHasOlder(entries.length === 100)
    } catch (failure) {
      if (mine === request.current) push(String(failure), 'err')
    } finally {
      if (mine === request.current) setBusy(false)
    }
  }

  if (!owner) return <p className="settings-note">Only an organization owner can read the admin log.</p>
  const names = new Map(members.map((person) => [person.userId, person.email]))
  return (
    <section className="settings-section">
      <div className="settings-label">Admin log</div>
      <div className="settings-list">
        {log.map((entry) => (
          <div className="settings-row" key={entry.id}>
            <div className="settings-provider">
              <span className="settings-name">
                {ACTION_NAMES[entry.action] ?? entry.action}
                {entry.subject !== null && names.has(entry.subject) ? ` · ${names.get(entry.subject)}` : ''}
              </span>
              <span className="settings-state">
                {new Date(entry.at).toLocaleString()} · {names.get(entry.actorId) ?? 'Former member'}
                {entry.detail === null ? '' : ` · ${entry.detail}`}
              </span>
            </div>
          </div>
        ))}
      </div>
      {log.length === 0 && <p className="settings-note">No admin actions yet.</p>}
      {hasOlder && (
        <button className="btn btn-ghost" disabled={busy} onClick={() => void loadOlder()}>
          Load older actions
        </button>
      )}
    </section>
  )
}
