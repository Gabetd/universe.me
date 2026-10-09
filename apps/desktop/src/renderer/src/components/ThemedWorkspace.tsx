import { rgb01ToHex, type Typography } from '@universe/core'
import type { CSSProperties, ReactNode, Ref } from 'react'
import { useTimelineOwner } from '../store'
import { useThemeLook } from '../world/useThemeLook'

/** Type that every computer has: nothing is downloaded. */
export const FONT_STACKS: Record<Typography, string> = {
  serif: 'Georgia, Cambria, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace'
}

/**
 * The workspace, taking on the theme in force on the world in view (PLAN.md
 * §4.5's UI accent and type): CSS mixes the theme's accent into the app's
 * own as much as the theme shows (in 32 steps, so a blend restyles the page a
 * few dozen times rather than every frame), and titles over the views take
 * its type. They're the workspace's own styles, so they go when it does.
 */
export function ThemedWorkspace({ ref, children, phoneTab }: { ref: Ref<HTMLDivElement>; children: ReactNode; phoneTab?: string }) {
  const owner = useTimelineOwner()
  const look = useThemeLook(owner?.kind === 'world' ? owner.id : undefined)
  const style = look && {
    '--theme-accent': rgb01ToHex(look.accent),
    '--theme-strength': `${(Math.round(look.strength * 32) / 32) * 100}%`,
    ...(look.strength > 0.5 && { '--theme-font': FONT_STACKS[look.dominant.typography] })
  }
  return (
    <div className={look ? 'workspace themed' : 'workspace'} ref={ref} style={style as CSSProperties | undefined} data-phone-tab={phoneTab}>
      {children}
    </div>
  )
}
