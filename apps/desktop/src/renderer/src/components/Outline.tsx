import { ancestry, buildTree, type TreeNode } from '@universe/core'
import { memo, useCallback, useMemo, useState } from 'react'
import { KIND_ICONS } from '../kinds'
import { useUi } from '../store'
import { menuRef } from '../contextMenu'

export function Outline() {
  const nodes = useUi((s) => s.nodes)
  const selectedId = useUi((s) => s.selectedId)
  const tree = useMemo(() => buildTree(nodes), [nodes])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Keep the selection visible: its ancestors are always expanded.
  const path = useMemo(() => new Set(selectedId ? ancestry(nodes, selectedId).map((n) => n.id) : []), [nodes, selectedId])

  const toggle = useCallback(
    (id: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    []
  )

  if (!tree) return null
  return (
    <ul className="tree" role="tree">
      <Row node={tree} depth={0} collapsed={collapsed} path={pathFor(path, tree.id)} toggle={toggle} />
    </ul>
  )
}

/** The selection's path for a row on it, and nothing for the others: their props stay the same when the selection moves. */
const pathFor = (path: Set<string> | undefined, id: string) => (path?.has(id) ? path : undefined)

interface RowProps {
  node: TreeNode
  depth: number
  collapsed: Set<string>
  /** The ids from the root to the selection, given only to the rows on it (which are kept open). */
  path: Set<string> | undefined
  toggle(id: string): void
}

/** Memoized: selecting something re-renders only the rows on the old and new paths to the selection. */
const Row = memo(function Row({ node, depth, collapsed, path, toggle }: RowProps) {
  const selected = useUi((s) => s.selectedId === node.id)
  const select = useUi((s) => s.select)
  const hasChildren = node.children.length > 0
  const open = hasChildren && (!collapsed.has(node.id) || (!!path && !selected))

  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={hasChildren ? open : undefined}>
      <div className={`tree-row${selected ? ' selected' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} data-menu={menuRef('node', node.id)} onClick={() => select(node.id)}>
        <button
          className="tree-caret link"
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation()
            toggle(node.id)
          }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="tree-icon">{KIND_ICONS[node.kind]}</span>
        <span className="tree-name">{node.name}</span>
      </div>
      {open && (
        <ul role="group">
          {node.children.map((c) => (
            <Row key={c.id} node={c} depth={depth + 1} collapsed={collapsed} path={pathFor(path, c.id)} toggle={toggle} />
          ))}
        </ul>
      )}
    </li>
  )
})
