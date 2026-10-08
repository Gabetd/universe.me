import { useEffect, useLayoutEffect, useRef } from 'react'
import { openElementMenu, parseMenuRef, useContextMenu } from '../contextMenu'

/** Where a right-click keeps the system's own behaviour: text being edited. */
const EDITING = 'input, textarea, select, [contenteditable="true"]'

/**
 * The right-click menu (see contextMenu.ts): opened on any element marked
 * with `data-menu`, or by a view for what's under its pointer. It goes away
 * on a click elsewhere, Escape, a scroll or the window losing focus; the
 * arrow keys move through it and Enter picks.
 */
export function ContextMenuHost() {
  const menu = useContextMenu((s) => s.menu)
  const close = useContextMenu((s) => s.close)
  const ref = useRef<HTMLDivElement>(null)

  // A right-click on a marked element, unless a view already answered it.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const target = e.target as Element
      if (target.closest(EDITING)) return
      e.preventDefault()
      const el = target.closest<HTMLElement>('[data-menu]')
      const marked = parseMenuRef(el?.dataset.menu)
      if (!marked) return close()
      // From the keyboard (the menu key, Shift+F10) there's no pointer: under the element instead.
      const box = el!.getBoundingClientRect()
      const keyboard = e.button === 0 && e.clientX === 0 && e.clientY === 0
      openElementMenu(marked, keyboard ? box.left + 8 : e.clientX, keyboard ? box.bottom : e.clientY)
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [close])

  // Inside the window, where it was asked for if there's room (moved before it's painted); focused, for the keyboard.
  useLayoutEffect(() => {
    const el = ref.current
    if (!menu || !el) return
    const box = el.getBoundingClientRect()
    el.style.setProperty('left', `${Math.max(4, Math.min(menu.x, window.innerWidth - box.width - 4))}px`)
    el.style.setProperty('top', `${Math.max(4, Math.min(menu.y, window.innerHeight - box.height - 4))}px`)
    el.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && close()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('wheel', outside, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('wheel', outside, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, close])

  if (!menu) return null
  const move = (e: React.KeyboardEvent, by: number) => {
    e.preventDefault()
    const items = [...ref.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(i + by + items.length) % items.length]?.focus()
  }
  return (
    <div
      ref={ref}
      className="context-menu floating"
      role="menu"
      aria-label={menu.title ?? 'Options'}
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(e, 1)
        else if (e.key === 'ArrowUp') move(e, -1)
      }}
    >
      {menu.title && <div className="context-menu-title">{menu.title}</div>}
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? 'danger-text' : undefined}
            onClick={() => {
              close()
              item.run()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
