import { memoize } from '@universe/core'
import { useEffect } from 'react'
import { create } from 'zustand'
import { NO_COLLABORATION, type Collaboration, type PersonIn, type Where } from '../../shared/api'
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

export const useCollaboration = create<Collaboration>(() => NO_COLLABORATION)

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

/** The people on each node, worked out once for each list of who's in, each node's list kept while its people stay put. */
let grouped: ReadonlyMap<string, PersonIn[]> | undefined
const byNode = memoize((here: PersonIn[]) => (grouped = peopleByNode(here, grouped)))

/** The people on a node now (undefined with no one there): the same list until someone comes to it, goes or moves on it. */
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
 * to see, each time the selection or the view changes (main lets one that's
 * the same as before go); with the project closed (the workspace gone), that
 * they're nowhere.
 */
export function useTellWhere(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const tell = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void window.universe.setWhere(whereNow()), WHERE_MS)
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
