import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** How long the pointer rests on a value before it says what it changes. */
export const HINT_DELAY_MS = 1000
/** Room kept between a hint and the window's edges, and between it and what it's about. */
const MARGIN = 8

/** Marks an element as explained by `hint` when the pointer rests on it (nothing, if there's no hint). */
export const hinted = (hint: string | undefined) => (hint ? { 'data-hint': hint } : {})

/**
 * What a value changes, said when the pointer rests on it for a second: any
 * element with `data-hint` (see `hinted`) gets a bubble beside it, below it
 * where there's room. One for the whole app, so fields only say what they do;
 * moving away, pressing a key or a button, or scrolling puts it away.
 */
export function HintLayer() {
  const [shown, setShown] = useState<{ text: string; box: DOMRect } | null>(null)
  const bubble = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer = 0
    let over: Element | null = null
    const hide = () => {
      clearTimeout(timer)
      setShown(null)
    }
    const onOver = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-hint]') : null
      if (el === over) return
      over = el
      hide()
      if (!el) return
      timer = window.setTimeout(() => {
        const text = el.getAttribute('data-hint')
        if (text && el.isConnected) setShown({ text, box: el.getBoundingClientRect() })
      }, HINT_DELAY_MS)
    }
    const away = () => {
      over = null
      hide()
    }
    document.addEventListener('pointerover', onOver)
    document.documentElement.addEventListener('pointerleave', away)
    for (const type of ['pointerdown', 'keydown', 'scroll', 'wheel'] as const) window.addEventListener(type, hide, true)
    window.addEventListener('blur', away)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerover', onOver)
      document.documentElement.removeEventListener('pointerleave', away)
      for (const type of ['pointerdown', 'keydown', 'scroll', 'wheel'] as const) window.removeEventListener(type, hide, true)
      window.removeEventListener('blur', away)
    }
  }, [])

  // Placed once it's measured: under what it explains (or over it, near the bottom), kept inside the window.
  useLayoutEffect(() => {
    const el = bubble.current
    if (!shown || !el) return
    const { box } = shown
    const [w, h] = [el.offsetWidth, el.offsetHeight]
    const left = Math.min(window.innerWidth - w - MARGIN, Math.max(MARGIN, box.left + box.width / 2 - w / 2))
    const below = box.bottom + MARGIN + h <= window.innerHeight - MARGIN
    el.style.left = `${left}px`
    el.style.top = `${below ? box.bottom + MARGIN : Math.max(MARGIN, box.top - MARGIN - h)}px`
    el.style.visibility = 'visible'
  }, [shown])

  if (!shown) return null
  return (
    <div ref={bubble} className="hint-bubble" role="tooltip" style={{ visibility: 'hidden' }}>
      {shown.text}
    </div>
  )
}
