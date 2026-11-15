import { useEffect, useRef, useState } from 'react'
import type { OrgInvite, OrgMember } from '../../../shared/org'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { useToasts } from '../../components/ui/Toast'
import { useOrganization } from '../../state/organization'

export function OrgMembersPage() {
  const overview = useOrganization((state) => state.overview)
  const connection = useOrganization((state) => state.connection)
  const owner = overview?.role === 'owner'
  const push = useToasts((state) => state.push)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [invites, setInvites] = useState<OrgInvite[]>([])
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [inviteMessage, setInviteMessage] = useState<string | null>(null)
  const [removing, setRemoving] = useState<OrgMember | null>(null)
  const [deleting, setDeleting] = useState<OrgMember | null>(null)
  const request = useRef(0)

  async function load(mine: number) {
    const [people, pending] = await Promise.all([window.loom.org.members(), window.loom.org.invites()])
    if (mine !== request.current) return
    setMembers(people)
    setInvites(pending)
  }

  useEffect(() => {
    const mine = ++request.current
    setMembers([])
    setInvites([])
    setInviteMessage(null)
    setRemoving(null)
    setDeleting(null)
    setBusy(false)
    if (owner)
      void load(mine).catch((failure: unknown) => {
        if (mine === request.current) push(String(failure), 'err')
      })
    return () => {
      request.current++
    }
  }, [connection, owner, push])

  async function act(operation: (current: () => boolean) => Promise<unknown>) {
    const mine = ++request.current
    const current = () => mine === request.current
    setBusy(true)
    try {
      await operation(current)
    } catch (failure) {
      if (current()) push(String(failure), 'err')
    } finally {
      if (current()) {
        await useOrganization.getState().refresh()
        if (current() && useOrganization.getState().overview?.role === 'owner') {
          await load(mine).catch((failure: unknown) => {
            if (current()) push(String(failure), 'err')
          })
        }
        if (current()) setBusy(false)
      }
    }
  }

  if (!owner) return <p className="settings-note">Only an organization owner can manage membership.</p>
  return (
    <>
      <section className="settings-section">
        <div className="settings-label">Invite a member</div>
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async (current) => {
              const result = await window.loom.org.invite(email.trim())
              if (!current()) return
              const runner = await window.loom.cloud.runner()
              if (!current() || runner.url === null) return
              const download = runner.url.replace(/^ws/, 'http').replace(/\/$/, '')
              setInviteMessage(
                `Join ${overview.organization.name || 'our organization'} on Loom.\nDownload: ${download}/download\nInvite code: ${result.code}\nFor ${result.invite.email}, until ${new Date(result.invite.expiresAt).toLocaleString()}.`
              )
              setEmail('')
            })
          }}
        >
          <Field label="Work email" hint="The code works once, for this address, for seven days.">
            <input
              className="input"
              type="email"
              required
              maxLength={254}
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <button className="btn" disabled={busy || email.trim() === ''}>
            Create invite
          </button>
        </form>
      </section>
      <section className="settings-section">
        <div className="settings-label">Members</div>
        <div className="settings-list">
          {members.map((person) => (
            <div className="settings-row" key={person.userId}>
              <div className="settings-provider">
                <span className="settings-name">{person.email}</span>
                <span className="settings-state">
                  {person.role} · {person.kind} · {person.state}
                </span>
              </div>
              {person.state === 'active' && (
                <>
                  {person.kind === 'human' && (
                    <button
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          window.loom.org.setRole(person.userId, person.role === 'owner' ? 'member' : 'owner')
                        )
                      }
                    >
                      {person.role === 'owner' ? 'Make member' : 'Make owner'}
                    </button>
                  )}
                  <button className="btn btn-danger" disabled={busy} onClick={() => setRemoving(person)}>
                    Remove
                  </button>
                </>
              )}
              {person.state === 'removed' && person.purgedAt === null && (
                <button className="btn btn-danger" disabled={busy} onClick={() => setDeleting(person)}>
                  {person.purgeStartedAt === null ? 'Delete files' : 'Retry deletion'}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-label">Invites</div>
        <div className="settings-list">
          {invites.map((invite) => {
            const state =
              invite.usedAt !== null
                ? 'Used'
                : invite.revokedAt !== null
                  ? 'Revoked'
                  : invite.expiresAt <= Date.now()
                    ? 'Expired'
                    : 'Pending'
            return (
              <div className="settings-row" key={invite.id}>
                <div className="settings-provider">
                  <span className="settings-name">{invite.email}</span>
                  <span className="settings-state">
                    {state} · Expires {new Date(invite.expiresAt).toLocaleString()}
                  </span>
                </div>
                {state === 'Pending' && (
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => void act(() => window.loom.org.revokeInvite(invite.id))}
                  >
                    Revoke
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {invites.length === 0 && <p className="settings-note">No invites yet.</p>}
      </section>
      <Modal
        open={inviteMessage !== null}
        title="Invite created"
        onClose={() => setInviteMessage(null)}
        footer={
          <button
            className="btn"
            onClick={() =>
              void navigator.clipboard.writeText(inviteMessage ?? '').then(
                () => push('Copied invite message'),
                () => push('Could not copy; select the message and copy it.', 'err')
              )
            }
          >
            Copy message
          </button>
        }
      >
        <p className="settings-note">Send this message to the invitee. The code is shown only here.</p>
        <textarea
          className="input"
          rows={7}
          readOnly
          value={inviteMessage ?? ''}
          aria-label="Invite message"
        />
      </Modal>
      <Modal
        open={deleting !== null}
        title="Delete removed member’s files"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                if (deleting !== null)
                  void act(async (current) => {
                    await window.loom.org.purgeMember(deleting.userId)
                    if (current()) setDeleting(null)
                  })
              }}
            >
              Delete files
            </button>
          </>
        }
      >
        <p>
          Permanently delete {deleting?.email}’s workspaces, conversations, and saved logins now? They cannot
          be recovered from Loom. Existing snapshots expire after seven days.
        </p>
      </Modal>
      <Modal
        open={removing !== null}
        title="Remove member"
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                if (removing !== null)
                  void act(async (current) => {
                    await window.loom.org.removeMember(removing.userId)
                    if (current()) setRemoving(null)
                  })
              }}
            >
              Remove member
            </button>
          </>
        }
      >
        <p>
          Remove {removing?.email}? Their sign-ins end and running workspaces stop. Files remain for 30 days.
        </p>
      </Modal>
    </>
  )
}
