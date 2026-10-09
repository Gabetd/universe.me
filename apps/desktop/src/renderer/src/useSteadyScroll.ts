import { useEffect, type RefObject } from 'react'

/** Controls: using one is what the panel keeps in place. */
const CONTROLS = 'input, select, textarea, button, [contenteditable="true"]'

/**
 * Keeps a scrolling panel still while you work in it: the control you last
 * used stays exactly where it is on screen, however the content around it
 * grows, shrinks or is redrawn after a change (text above it that changes,
 * a list below it that fills in again). Only a scroll (yours, by wheel,
 * scrollbar or keys, or Tab moving to a control out of view) lets it move,
 * and `menu` changing (something else picked) shows the new content from
 * the top.
 *
 * `contentRef` is the panel's content; its parent is the element that scrolls.
 */
export function useSteadyScroll(contentRef: RefObject<HTMLElement | null>, menu: string): void {
  useEffect(() => {
    const content = contentRef.current
    const panel = content?.parentElement
    if (!content || !panel) return
    // This does the browser's scroll anchoring, for the control rather than whatever's at the top: two at once would fight.
    panel.style.setProperty('overflow-anchor', 'none')
    /** Where this hook last scrolled the panel to: a scroll event anywhere else is someone else's. */
    let ours = 0
    const scrollTo = (top: number) => {
      panel.scrollTo({ top })
      ours = panel.scrollTop
    }
    scrollTo(0)

    /** The control last used, where it was, and which control it is in the panel (for one redrawn in its place). */
    let anchor: { el: Element; index: number; offset: number } | undefined
    /** Space added above the content, where it got shorter above the control by more than the panel can scroll back. */
    let pad = 0
    const controls = () => [...content.querySelectorAll(CONTROLS)]
    const offsetOf = (el: Element) => el.getBoundingClientRect().top - panel.getBoundingClientRect().top
    const setPad = (px: number) => {
      pad = px
      if (px) content.style.setProperty('margin-top', `${px}px`)
      else content.style.removeProperty('margin-top')
    }

    const hold = (e: Event) => {
      const target = e.target as Element
      const el = target.closest(CONTROLS) ?? target
      if (!content.contains(el)) return
      anchor = { el, index: controls().indexOf(el), offset: offsetOf(el) }
      // Room to stay put if what's below gets shorter.
      content.style.setProperty('min-height', `${content.offsetHeight}px`)
    }
    const release = () => {
      anchor = undefined
      content.style.removeProperty('min-height')
      // The space goes, and what's on screen stays put as far as the panel can scroll.
      const was = pad
      setPad(0)
      if (was) scrollTo(panel.scrollTop - was)
    }
    const put = () => {
      if (anchor && !anchor.el.isConnected && anchor.index >= 0) anchor.el = controls()[anchor.index] ?? anchor.el
      if (!anchor?.el.isConnected) return
      let drift = offsetOf(anchor.el) - anchor.offset
      if (Math.abs(drift) < 1) return
      // Moved down: take back space added before, then scroll. Moved up beyond the top: add space.
      const taken = Math.min(pad, Math.max(drift, 0))
      setPad(pad - taken)
      drift -= taken
      const top = panel.scrollTop + drift
      if (top < 0) setPad(pad - top)
      scrollTo(Math.max(top, 0))
    }
    // At once, and again once the frame is laid out (styles and sizes that settle late).
    let frame = 0
    const restore = () => {
      put()
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(put)
    }
    const onScroll = () => Math.abs(panel.scrollTop - ours) >= 1 && release()

    // After each change React makes, and anything that resizes later, put the control back.
    const changes = new MutationObserver(restore)
    changes.observe(content, { subtree: true, childList: true, attributes: true, characterData: true })
    const sizes = new ResizeObserver(restore)
    sizes.observe(content)
    const using = ['pointerdown', 'keydown', 'focusin'] as const
    for (const type of using) panel.addEventListener(type, hold)
    panel.addEventListener('scroll', onScroll, { passive: true })
    // The wheel lets go at once: its scroll event comes a frame later, and a redraw before then would put the control back.
    panel.addEventListener('wheel', release, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      changes.disconnect()
      sizes.disconnect()
      for (const type of using) panel.removeEventListener(type, hold)
      panel.removeEventListener('scroll', onScroll)
      panel.removeEventListener('wheel', release)
      release()
    }
  }, [contentRef, menu])
}
