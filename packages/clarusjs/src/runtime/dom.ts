// Attach helpers: find markers in server HTML and keep them updated. Browser only. Never re-renders existing HTML;
// only @if branches and @for rows that did not exist on the server are rendered here.
import { attrValue } from './attrs.ts'
import { effect, onDispose, scope, state, untrack, type Signal } from './signals.ts'

export type Hole = { start: Comment; end: Comment }
export type Block = { start: Comment; end: Comment; k: number }
type Range = { start: Comment; end: Comment }
export type For = Range & { rows: Range[]; empty: Range | null }

/**
 * Where wiring looks for its markers: a whole island, or one @for row inside it. A row template repeats its marker
 * numbers once per row, so code wiring a row only looks between that row's markers.
 */
export type Ctx = Element | { root: Element; start: Comment; end: Comment }

const rootOf = (ctx: Ctx): Element => ('root' in ctx ? ctx.root : ctx)

/** Is `node` inside `ctx` (always true for a whole island)? */
function inside(ctx: Ctx, node: Node): boolean {
  if (!('root' in ctx)) return true
  return !!(ctx.start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) &&
    !!(ctx.end.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)
}

/**
 * Find every marker in `ctx`, skipping nested islands:
 * holes `<!--[N-->`, @if blocks `<!--[bN:K-->`, @for lists `<!--[fN-->` with rows `<!--[r-->` and `<!--[e-->`,
 * all closed by `<!--]-->`.
 */
function scan(ctx: Ctx): { holes: Hole[]; blocks: Block[]; fors: For[]; regions: Range[] } {
  const root = rootOf(ctx)
  const holes: Hole[] = []
  const blocks: Block[] = []
  const fors: For[] = []
  const regions: Range[] = []
  type Open = { kind: 'hole' | 'block' | 'for' | 'row' | 'empty' | 'region'; index: number; k: number; start: Comment; rows: Range[]; empty: Range | null }
  const open: Open[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT, {
    acceptNode: (n) =>
      n.nodeType === 8 ? NodeFilter.FILTER_ACCEPT
      : n !== root && (n as Element).localName === 'cl-island' ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_SKIP,
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!inside(ctx, n)) continue
    const c = n as Comment
    const data = c.data
    let m: RegExpExecArray | null
    const push = (kind: Open['kind'], index = 0, k = 0) => open.push({ kind, index, k, start: c, rows: [], empty: null })
    if ((m = /^\[(\d+)$/.exec(data))) push('hole', Number(m[1]))
    else if ((m = /^\[b(\d+):(-?\d+)$/.exec(data))) push('block', Number(m[1]), Number(m[2]))
    else if ((m = /^\[f(\d+)$/.exec(data))) push('for', Number(m[1]))
    else if ((m = /^\[c(\d+)$/.exec(data))) push('region', Number(m[1]))
    else if (data === '[r') push('row')
    else if (data === '[e') push('empty')
    else if (data === ']' && open.length) {
      const o = open.pop()!
      const parent = open[open.length - 1]
      if (o.kind === 'hole') holes[o.index] = { start: o.start, end: c }
      else if (o.kind === 'block') blocks[o.index] = { start: o.start, end: c, k: o.k }
      else if (o.kind === 'for') fors[o.index] = { start: o.start, end: c, rows: o.rows, empty: o.empty }
      else if (o.kind === 'region') regions[o.index] = { start: o.start, end: c }
      else if (parent?.kind === 'for') {
        if (o.kind === 'row') parent.rows.push({ start: o.start, end: c })
        else parent.empty = { start: o.start, end: c }
      }
    }
  }
  return { holes, blocks, fors, regions }
}

/** Hole markers in `ctx`, by index. */
export function holes(ctx: Ctx): Hole[] {
  return scan(ctx).holes
}

/** @if block markers in `ctx`, by index. */
export function blocks(ctx: Ctx): Block[] {
  return scan(ctx).blocks
}

/** Turn HTML into nodes and put them before `end`; returns the first and last inserted node. */
function insertHtml(html: string, end: Node): { first: Node | null; last: Node | null } {
  const t = document.createElement('template')
  t.innerHTML = html
  const first = t.content.firstChild
  const last = t.content.lastChild
  end.parentNode!.insertBefore(t.content, end)
  // Child islands in the new HTML attach like the ones on the page (the loader registers this hook).
  const attachIslands = (globalThis as { __clAttach?: (root: ParentNode) => void }).__clAttach
  if (attachIslands && end.parentNode) attachIslands(end.parentNode)
  return { first, last }
}

/** The nodes from `start` to `end`, both included. */
function rangeNodes(start: Node, end: Node): Node[] {
  const nodes: Node[] = []
  for (let n: Node | null = start; n; n = n.nextSibling) {
    nodes.push(n)
    if (n === end) break
  }
  return nodes
}

/**
 * An @if block. `which()` picks the branch (-1 for none). The server-rendered branch is wired in place; a change
 * removes the old branch (disposing its effects and handlers), inserts the new branch's HTML and wires it.
 */
export function block(ctx: Ctx, index: number, which: () => number, branches: { html: () => string; wire: () => void }[]): void {
  const b = blocks(ctx)[index]
  if (!b) return
  let current = b.k
  let dispose: (() => void) | null = null
  let first = true
  onDispose(() => dispose?.()) // removing the enclosing branch or row removes this one's too
  effect(() => {
    const k = which()
    untrack(() => {
      if (!first && k === current) return
      if (k !== current) {
        dispose?.()
        while (b.start.nextSibling && b.start.nextSibling !== b.end) b.start.nextSibling.remove()
        if (k >= 0) insertHtml(branches[k]!.html(), b.end)
        current = k
      }
      first = false
      dispose = k >= 0 ? scope(() => branches[k]!.wire()) : null
    })
  })
}

/**
 * A child component inside an island whose props or content read state. `html()` renders it with the current
 * values; when anything it read changes, the old HTML is disposed and replaced, and `wire()` wires the island's own
 * holes and events in the child's slot content again. A stateful child is remounted with its new props.
 */
/** The one <cl-island> among `nodes` (blank text aside), or null. */
const onlyIsland = (nodes: Node[]): Element | null => {
  const kept = nodes.filter((n) => n.nodeType !== 3 || n.textContent!.trim())
  return kept.length === 1 && (kept[0] as Element).localName === 'cl-island' ? (kept[0] as Element) : null
}

export function region(ctx: Ctx, index: number, html: () => string, wire: () => void): void {
  const r = scan(ctx).regions[index]
  if (!r) return
  let dispose: (() => void) | null = null
  let first = true
  onDispose(() => dispose?.())
  effect(() => {
    const next = html()
    untrack(() => {
      if (!first) {
        // A nested island with new props is updated in place (DOM and state kept), not replaced.
        const t = document.createElement('template')
        t.innerHTML = next
        const between: Node[] = []
        for (let n = r.start.nextSibling; n && n !== r.end; n = n.nextSibling) between.push(n)
        const old = onlyIsland(between)
        const fresh = onlyIsland([...t.content.childNodes])
        if (old && fresh && (globalThis as { __clUpdate?: (el: Element, next: Element) => boolean }).__clUpdate?.(old, fresh)) return
        dispose?.()
        while (r.start.nextSibling && r.start.nextSibling !== r.end) r.start.nextSibling.remove()
        insertHtml(next, r.end)
      }
      first = false
      dispose = scope(wire)
    })
  })
}

type Row = Range & { key: unknown; item: Signal<unknown>; index: Signal<number>; dispose: () => void }

/**
 * A @for list. Rows the server rendered are adopted in place. When the list changes, rows are matched by key:
 * kept rows keep their DOM nodes (moved only when out of order) and get the new item and index through their
 * signals; new rows are rendered and wired; removed rows are disposed and removed. `@empty` content is shown while
 * the list is empty.
 */
export function forBlock(
  ctx: Ctx,
  index: number,
  list: () => unknown,
  keyOf: (item: any, i: number) => unknown,
  row: { html: (item: any, i: number) => string; wire: (ctx: Ctx, item: Signal<any>, index: Signal<number>) => void },
  empty: { html: () => string; wire: (ctx: Ctx) => void } | null,
): void {
  const f = scan(ctx).fors[index]
  if (!f) return
  const root = rootOf(ctx)
  let rows: Row[] = []
  let emptyRange: (Range & { dispose: () => void }) | null = null
  let first = true

  const wireRow = (range: Range, key: unknown, item: unknown, i: number): Row => {
    const itemS = state(item)
    const indexS = state(i)
    const dispose = scope(() => row.wire({ root, ...range }, itemS, indexS))
    return { ...range, key, item: itemS, index: indexS, dispose }
  }
  const wireEmpty = (range: Range) => ({ ...range, dispose: empty ? scope(() => empty.wire({ root, ...range })) : () => {} })

  onDispose(() => {
    for (const r of rows) r.dispose()
    emptyRange?.dispose()
  })

  effect(() => {
    const items = [...((list() ?? []) as Iterable<unknown>)]
    untrack(() => {
      // Keys, made unique: a repeated key would make two rows share one identity.
      const seen = new Set<unknown>()
      const keys = items.map((item, i) => {
        let key = keyOf(item, i)
        if (seen.has(key)) {
          // Development only: Vite replaces import.meta.env.DEV, so a production build drops it (no ImportMeta
          // declaration needed: consumers of this source typecheck without one).
          if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.warn(`[clarusjs] @for: duplicate key ${String(key)}; rows with repeated keys are matched by position`)
          key = `${String(key)}\u0000${i}`
        }
        seen.add(key)
        return key
      })

      if (first) {
        first = false
        rows = f.rows.map((range, i) => wireRow(range, keys[i], items[i], i))
        if (f.empty) emptyRange = wireEmpty(f.empty)
        return
      }

      const old = new Map(rows.map((r) => [r.key, r]))
      const next = items.map((item, i) => {
        const kept = old.get(keys[i])
        if (kept) {
          old.delete(keys[i])
          kept.item.set(item)
          kept.index.set(i)
          return kept
        }
        const { first: start, last: end } = insertHtml(`<!--[r-->${row.html(item, i)}<!--]-->`, f.end)
        return wireRow({ start: start as Comment, end: end as Comment }, keys[i], item, i)
      })
      for (const r of old.values()) {
        r.dispose()
        for (const n of rangeNodes(r.start, r.end)) n.parentNode?.removeChild(n)
      }
      // Put rows in order, moving only those that are not already right after the previous one.
      let anchor: Node = f.start
      for (const r of next) {
        if (anchor.nextSibling !== r.start) (anchor as ChildNode).after(...rangeNodes(r.start, r.end))
        anchor = r.end
      }
      rows = next

      if (items.length && emptyRange) {
        emptyRange.dispose()
        for (const n of rangeNodes(emptyRange.start, emptyRange.end)) n.parentNode?.removeChild(n)
        emptyRange = null
      } else if (!items.length && !emptyRange && empty) {
        const { first: start, last: end } = insertHtml(`<!--[e-->${empty.html()}<!--]-->`, f.end)
        emptyRange = wireEmpty({ start: start as Comment, end: end as Comment })
      }
    })
  })
}

/** Keep exactly one text node between the hole's markers, set to `fn()`. */
export function text(hole: Hole, fn: () => unknown): void {
  effect(() => {
    const value = fn()
    const s = value == null ? '' : String(value)
    const first = hole.start.nextSibling
    if (first && first !== hole.end && first.nodeType === 3 && first.nextSibling === hole.end) {
      if ((first as Text).data !== s) (first as Text).data = s
      return
    }
    while (hole.start.nextSibling && hole.start.nextSibling !== hole.end) hole.start.nextSibling.remove()
    hole.end.before(document.createTextNode(s))
  })
}

type Handler = { fn: (e: Event) => void; ctx: Ctx }
const registry = new WeakMap<Element, Map<string, Map<number, Handler[]>>>()
// These don't bubble, so they are caught on the way down instead.
const CAPTURE = new Set(['focus', 'blur'])

/**
 * Register a handler for elements marked `data-cl-e="index"` inside `ctx`.
 * One listener per island per event type; it walks from the target up to the island root, running handlers
 * innermost first and stopping when one calls `stopPropagation()`. A handler registered for a @for row only fires
 * for elements in that row.
 */
export function on(ctx: Ctx, index: number, type: string, fn: (e: Event) => void): void {
  const root = rootOf(ctx)
  let types = registry.get(root)
  if (!types) registry.set(root, (types = new Map()))
  let handlers = types.get(type)
  if (!handlers) {
    const own: Map<number, Handler[]> = (handlers = new Map())
    types.set(type, own)
    root.addEventListener(type, (e) => {
      for (let el = e.target as Element | null; el && el !== root.parentElement; el = el.parentElement) {
        const i = el.getAttribute?.('data-cl-e')
        if (i === null || i === undefined || el.closest('cl-island') !== root) continue
        for (const h of [...(own.get(Number(i)) ?? [])]) if (inside(h.ctx, el)) h.fn(e)
        if (e.cancelBubble) break
      }
    }, CAPTURE.has(type))
  }
  if (!handlers.has(index)) handlers.set(index, [])
  const list = handlers.get(index)!
  const handler = { fn, ctx }
  list.push(handler)
  onDispose(() => { const at = list.indexOf(handler); if (at !== -1) list.splice(at, 1) }) // a removed branch or row stops listening
}

/** Keep attribute `name` of the element marked `data-cl-a="index"` in `ctx` in sync with `fn()`. */
export function attr(ctx: Ctx, index: number, name: string, fn: () => unknown, tag?: string): void {
  const root = rootOf(ctx)
  const el = [...root.querySelectorAll(`[data-cl-a="${index}"]`)].find((e) => e.closest('cl-island') === root && inside(ctx, e))
  if (!el) return
  effect(() => {
    const v = attrValue(name, fn(), tag)
    if (v === null) el.removeAttribute(name)
    else el.setAttribute(name, v === true ? '' : v)
    // A form field shows its property once someone has typed or clicked in it, not the attribute: set both.
    if (name === 'value' && 'value' in el) (el as HTMLInputElement).value = v === null || v === true ? '' : v
    if (name === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = v !== null
  })
}

/**
 * A @model input: writing it asks the parent island to update its state (a bubbling, cancelable cl:model event from
 * the island); when no parent takes it (a top-level island), the input keeps the value itself. New props from the
 * parent set it with own().
 */
export function modelInput<T>(root: Element, name: string, initial: T): Signal<T> & { own(value: T): void } {
  const value = state(initial)
  return {
    initial,
    get: value.get,
    own: value.set,
    set(next) {
      if (root.dispatchEvent(new CustomEvent('cl:model', { detail: { name, value: next }, bubbles: true, cancelable: true }))) value.set(next)
    },
  }
}

/** [(name)]="…" on a child island in region `index`: the child's writes to its @model name arrive here. */
export function model(ctx: Ctx, index: number, name: string, set: (value: unknown) => void): void {
  const r = scan(ctx).regions[index]
  if (!r) return
  const host = r.start.parentNode!
  const listen = (event: Event) => {
    const detail = (event as CustomEvent<{ name: string; value: unknown }>).detail
    const from = event.target as Node
    // Only from inside this region: 4 = the target follows the start marker, 2 = it precedes the end marker.
    if (detail.name !== name || !(r.start.compareDocumentPosition(from) & 4) || !(r.end.compareDocumentPosition(from) & 2)) return
    event.preventDefault()
    event.stopPropagation()
    set(detail.value)
  }
  host.addEventListener('cl:model', listen)
  onDispose(() => host.removeEventListener('cl:model', listen))
}
