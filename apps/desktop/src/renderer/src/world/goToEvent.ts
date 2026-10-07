import type { TimelineEvent } from '@universe/core'
import { useUi } from '../store'
import { useTimelineView } from '../timeline/timelineStore'
import { useEditor } from './editorStore'

/**
 * Takes the user to when and where an event happened: the playhead moves to
 * its start (scrolling the timeline if it's off screen), the event is
 * selected, and the globe or map turns to its place.
 */
export function goToEvent(event: TimelineEvent): void {
  const view = useTimelineView.getState()
  const range = view.ranges[event.ownerId]
  if (range && (event.start < range.t0 || event.start > range.t1)) {
    const half = (range.t1 - range.t0) / 2
    view.setRange(event.ownerId, { t0: event.start - half, t1: event.start + half })
  }
  view.setPlayhead(event.ownerId, event.start)
  useUi.getState().selectTimeline({ kind: 'event', ids: [event.id] })
  const editor = useEditor.getState()
  editor.set({ view: editor.surfaceView, focusSeq: editor.focusSeq + 1 })
}
