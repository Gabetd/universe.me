import { Login, memberWithLogin, type Member } from '@universe/core'
import { useState, type CSSProperties, type FormEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ApiSettingsPatch, ApiStatus, Person, PersonIn, Where } from '../../../shared/api'
import { useCollaboration, usePeopleOn } from '../collaboration'
import { menuRef } from '../contextMenu'
import { initials, isWorldView, personHue, personLine } from '../people'
import { useUi } from '../store'
import { openView } from '../world/WorldEditor'
import { SectionError, stoppedLine, useApiStatus } from './AiPanels'
import { Modal, dialogStore } from './Modal'
import { zoomTo } from './zoom'

/**
 * A universe shared with other people (PLAN.md §6.7, with other people):
 * inviting them by their tailnet login and removing them (commands, undoable
 * like any), and who's in now and where, as marks in the top bar and on the
 * tree.
 */

/** Tailscale's list of machines, where a computer is shared with someone: opened in the browser, never in the app. */
const TAILSCALE_MACHINES = 'https://login.tailscale.com/admin/machines'

/** Whether the Share dialog is open. */
export const useShareDialog = dialogStore()
const close = () => useShareDialog.getState().set(false)

/** The top bar's button that opens the Share dialog. */
export function ShareButton() {
  const others = useUi((s) => s.timeline.members.length)
  return (
    <button onClick={() => useShareDialog.getState().set(true)} title={others ? 'Who this universe is shared with' : 'Share this universe with people on your tailnet'}>
      👥 Share
    </button>
  )
}

/** Someone's round mark: their initials, in a colour from their login. */
function Avatar({ person, small }: { person: Person; small?: boolean }) {
  return (
    <span className={`avatar${small ? ' small' : ''}`} style={{ '--hue': personHue(person.login) } as CSSProperties} aria-hidden>
      {initials(person.name)}
    </span>
  )
}

/** Goes where someone is, if it's in this copy too: the node they're on and, on a world, the view they have open. */
function goTo(where: Where | null): void {
  const node = where?.nodeId ? useUi.getState().nodes.find((n) => n.id === where.nodeId) : undefined
  if (!where || !node) return
  zoomTo(node.id)
  if (node.kind === 'world' && isWorldView(where.view)) openView(where.view, node.id)
}

/** In the top bar: a mark for each person in the universe now, which says where they are and goes there. */
export function PeopleIn() {
  const here = useCollaboration((s) => s.here)
  if (!here.length) return null
  return (
    <div className="people-in" role="group" aria-label="Who’s in">
      {here.map((p) => (
        <button key={p.login} className="avatar-button" title={personLine(p)} aria-label={personLine(p)} onClick={() => goTo(p.where)}>
          <Avatar person={p} />
        </button>
      ))}
    </div>
  )
}

/** After a tree row's name: a small mark for each person on that node now. */
export function PeopleOn({ nodeId }: { nodeId: string }) {
  const people = usePeopleOn(nodeId)
  if (!people) return null
  const line = people.map(personLine).join('; ')
  return (
    <span className="tree-people" title={line} aria-label={line}>
      {people.map((p) => (
        <Avatar key={p.login} person={p} small />
      ))}
    </span>
  )
}

/** The Share dialog, mounted afresh each time it opens (so Tailscale is looked at again). */
export function ShareDialog() {
  const open = useShareDialog((s) => s.open)
  return open ? <Share /> : null
}

function Share() {
  const [status, set] = useApiStatus()
  const { on, me, here, people } = useCollaboration(useShallow((s) => ({ on: s.on, me: s.me, here: s.here, people: s.people })))
  const members = useUi((s) => s.timeline.members)
  return (
    <Modal title="Share this universe" closeLabel="Close share" className="share-dialog" onClose={close}>
      <p className="muted small">
        Invite people by their Tailscale login. Their copy and yours keep each other up to date as you both work, directly over your tailnets (nothing in the cloud), and each of you sees who’s in and where.
      </p>
      {on && me ? <Invite me={me} people={people} members={members} /> : <SharingOff status={status} set={set} />}
      <Members members={members} here={here} me={me} />
    </Modal>
  )
}

/** What sharing waits for, in a line: Tailscale, signed in, and sync on. */
function offLine({ phone }: ApiStatus): string {
  const ts = phone.tailscale
  if (ts.kind === 'missing') return 'Sharing needs Tailscale on your computer and theirs: install it from tailscale.com and sign in, then open this again.'
  if (ts.kind === 'stopped') return stoppedLine(ts)
  if (!phone.sync.on) return 'Sharing works through sync, which is off on this computer.'
  return 'Asking Tailscale who’s signed in…'
}

/** Sharing can't start yet: why, and the switch for sync, as in the device list. */
function SharingOff({ status, set }: { status: ApiStatus | undefined; set(patch: ApiSettingsPatch): void }) {
  if (!status) return null
  const { sync, tailscale } = status.phone
  return (
    <div className="share-off">
      <p className="small" aria-label="Sharing status">
        {offLine(status)}
      </p>
      {tailscale.kind === 'ready' && !sync.on && (
        <button className="primary" onClick={() => set({ sync: true })}>
          Turn on sync
        </button>
      )}
      <SectionError error={sync.on ? sync.error : undefined} />
    </div>
  )
}

/** Inviting someone: one of the people Tailscale knows in a click, or anyone by their login. */
function Invite({ me, people, members }: { me: Person; people: Person[]; members: Member[] }) {
  const [login, setLogin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const suggestions = people.filter((p) => !memberWithLogin(members, p.login))

  const invite = async (person: { login: string; name?: string }) => {
    const parsed = Login.safeParse(person.login)
    if (!parsed.success) return setError('A tailnet login looks like an email address: ana@example.com, or ana@github.')
    if (memberWithLogin(members, parsed.data)) return setError(`${parsed.data} is in already.`)
    const { project, execute } = useUi.getState()
    const name = person.name ?? people.find((p) => p.login === parsed.data)?.name
    const done = await execute({ type: 'member.create', payload: { ownerId: project!.rootId, login: parsed.data, ...(name && { name }), invitedBy: me } })
    if (done) {
      setLogin('')
      setError(null)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void invite({ login })
  }

  return (
    <section className="share-invite" aria-label="Invite">
      <h3>Invite someone</h3>
      {suggestions.length > 0 && (
        <div className="chip-toggles" role="group" aria-label="On your tailnet">
          {suggestions.map((p) => (
            <button key={p.login} className="small" title={p.login} onClick={() => void invite(p)}>
              + {p.name}
            </button>
          ))}
        </div>
      )}
      <form className="share-invite-row" onSubmit={submit}>
        <input aria-label="Their tailnet login" placeholder="their tailnet login, as ana@example.com" value={login} onChange={(e) => setLogin(e.target.value)} />
        <button className="primary" type="submit" disabled={!login.trim()}>
          Invite
        </button>
      </form>
      {error && (
        <p className="small phone-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">
        They need to be on your tailnet, or have this computer shared with them in Tailscale (Share, on its machine’s menu).{' '}
        <a href={TAILSCALE_MACHINES} target="_blank" rel="noreferrer">
          Open Tailscale’s machines
        </a>
      </p>
    </section>
  )
}

/** Where a member is, in a few words: in now and where, or not. */
function memberLine(member: Member, you: boolean, inNow: PersonIn | undefined, members: Member[]): string {
  const by = member.invitedBy && members.find((m) => m.login === member.invitedBy)
  const invited = by ? ` · invited by ${by.name}` : ''
  if (you) return `you${invited}`
  if (!inNow) return `not in now${invited}`
  return `${inNow.where ? `in now, on ${inNow.where.label}` : 'in now'}${invited}`
}

/** Who the universe is shared with, and who's in now: each removed with its button or its right-click menu (but you). */
function Members({ members, here, me }: { members: Member[]; here: PersonIn[]; me: Person | null }) {
  const execute = useUi((s) => s.execute)
  return (
    <section className="share-people" aria-label="People">
      <h3>People</h3>
      {members.length === 0 ? (
        <p className="muted small">Only you, so far.</p>
      ) : (
        <ul className="connections share-members" aria-label="Members">
          {members.map((m) => {
            const you = m.login === me?.login
            return (
              <li key={m.id} data-menu={you ? undefined : menuRef('member', m.id)}>
                <span className="share-member">
                  <Avatar person={m} />
                  <span>
                    {m.name} <span className="muted">· {m.login}</span>
                    <span className="muted small share-member-where">{memberLine(m, you, here.find((p) => p.login === m.login), members)}</span>
                  </span>
                </span>
                {!you && (
                  <button className="link small" aria-label={`Remove ${m.name}`} onClick={() => void execute({ type: 'member.delete', payload: { id: m.id } })}>
                    Remove
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
