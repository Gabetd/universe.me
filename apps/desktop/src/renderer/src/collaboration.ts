import { useEffect } from 'react'
import { create } from 'zustand'
import type { Collaboration, PersonIn, Where } from '../../shared/api'
import { peopleByNode, whereOn } from './people'
import { useUi } from './store'
import { useEditor } from './world/editorStore'

/**
 * Several people in one universe (PLAN.md §6.7, with other people), as the
 * main process tells it: who's signed in, who's in and where, universes
 * shared with this user and people they could invite. Each part keeps its
 * object while it's the same, so a mark on a tree row or in the top bar
 * redraws only when what it shows changes, never the views.
 */

const NOBODY: Collaboration = { on: false, me: null, members: [], here: [], shared: [], people: [] }

export const useCollaboration = create<Collaboration>(() => NOBODY)

/** A new word from main: only the parts that changed are replaced. */
function take(next: Collaboration): void {
  const now = useCollaboration.getState()
  const changed = (Object.keys(next) as (keyof Collaboration)[]).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(now[key]))
  if (changed.length) useCollaboration.setState(Object.fromEntries(changed.map((key) => [key, next[key]])))
}

/** Listens to main from now on (the app does, once); the function returned stops. */
export function listenToCollaboration(): () => void {
  void window.universe.collaboration().then(take)
  return window.universe.onCollaboration(take)
}

let grouped: { here: PersonIn[]; byNode: Map<string, PersonIn[]> } | undefined
const byNode = (here: PersonIn[]) => (grouped?.here === here ? grouped.byNode : (grouped = { here, byNode: peopleByNode(here) }).byNode)

/** The people on a node now (undefined with no one there): the same list until someone comes, goes or moves. */
export const usePeopleOn = (nodeId: string): PersonIn[] | undefined => useCollaboration((s) => byNode(s.here).get(nodeId))

/** How long the selection or view stays put before the others are told: going through several says only the last. */
const WHERE_MS = 400

/** Where the user is now: the node selected and, on a world, its view. */
function whereNow(): Where | null {
  const { project, nodes, selectedId } = useUi.getState()
  if (!project) return null
  return whereOn(
    nodes.find((n) => n.id === selectedId),
    useEditor.getState().view,
    nodes.find((n) => n.id === project.rootId)?.name ?? project.name
  )
}

/**
 * Tells main where the user is (`setWhere`), for the others in the universe
 * to see, each time the selection or the view changes; with the project
 * closed (the workspace gone), that they're nowhere.
 */
export function useTellWhere(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let told = ''
    const tell = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const where = whereNow()
        const json = JSON.stringify(where)
        if (json === told) return
        told = json
        void window.universe.setWhere(where)
      }, WHERE_MS)
    }
    tell()
    const offUi = useUi.subscribe((s, before) => (s.selectedId !== before.selectedId || s.nodes !== before.nodes) && tell())
    const offEditor = useEditor.subscribe((s, before) => s.view !== before.view && tell())
    return () => {
      offUi()
      offEditor()
      clearTimeout(timer)
      void window.universe.setWhere(null)
    }
  }, [])
}
