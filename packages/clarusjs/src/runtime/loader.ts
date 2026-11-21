// Island loader: finds <cl-island> elements, loads each one's chunk when its attach mode says so, calls attach(),
// and replays what the visitor did before that. Browser only.

import { parse } from './serialize.ts'
import { scope } from './signals.ts'

type IslandModule = { attach(root: Element, props: Record<string, unknown>, state?: Record<string, unknown>): void | ((props: Record<string, unknown>) => void) }
type Load = (src: string) => Promise<IslandModule>

// Islands scheduled or loading. `data-cl-ready` is set only after attach() succeeds.
const loading = new WeakSet<Element>()
const updates = new WeakMap<Element, (props: Record<string, unknown>) => void>()
// Each attached island's disposer: everything its attach() wired (effects, listeners) is released by it.
const attached = new Map<Element, () => void>()

let lastLoad: Load = (src) => import(/* @vite-ignore */ src)

// Events recorded until an island attaches, then replayed. Clicks and submits are held back (no navigation, no
// form post) so the island can handle them once it is ready.
const REPLAY = ['click', 'submit', 'input', 'change', 'keydown'] as const
const HOLD = new Set(['click', 'submit'])
// What counts as using an island, for attach="interaction".
const INTERACTION = ['pointerdown', 'keydown', 'focusin', 'input', 'click', 'submit']

type Recorded = { type: string; target: Element; key?: string }

/** Record events aimed at this island (not at an island nested in it) until stop() is called. */
function record(el: Element): { events: Recorded[]; stop(): void } {
  const events: Recorded[] = []
  const listener = (e: Event) => {
    const target = e.target as Element | null
    if (!target || target.closest?.('cl-island') !== el) return
    if (HOLD.has(e.type)) e.preventDefault()
    events.push({ type: e.type, target, key: (e as KeyboardEvent).key })
  }
  for (const type of REPLAY) el.addEventListener(type, listener, true)
  return { events, stop: () => { for (const type of REPLAY) el.removeEventListener(type, listener, true) } }
}

/** Do again what the visitor did before the island attached, now that its handlers are listening. */
function replay(events: Recorded[]): void {
  for (const { type, target, key } of events) {
    if (!target.isConnected) continue
    if (type === 'click') (target as HTMLElement).click?.()
    else if (type === 'submit') {
      const form = target as HTMLFormElement
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    } else if (type === 'keydown') target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    else target.dispatchEvent(new Event(type, { bubbles: true }))
  }
}

/** Run `go` when the island's attach mode (`a` attribute) says: now, when idle, when visible, or on first use. */
function schedule(el: Element, go: () => void): void {
  const mode = el.getAttribute('a') ?? 'load'
  if (mode === 'idle') {
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
    if (idle) idle(go)
    else setTimeout(go, 200)
  } else if (mode === 'visible' && typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { io.disconnect(); go() }
    })
    io.observe(el)
  } else if (mode === 'interaction') {
    const start = () => { for (const type of INTERACTION) el.removeEventListener(type, start, true); go() }
    for (const type of INTERACTION) el.addEventListener(type, start, true)
  } else {
    go()
  }
}

async function attachOne(el: Element, load: Load, recorded: ReturnType<typeof record>): Promise<void> {
  let mod: IslandModule
  let props: Record<string, unknown>
  let state: Record<string, unknown> | undefined
  try {
    mod = await load(el.getAttribute('src')!)
    props = parse(el.getAttribute('p') ?? '{}') as Record<string, unknown>
    const s = el.getAttribute('s')
    state = s === null ? undefined : (parse(s) as Record<string, unknown>)
  } catch (err) {
    recorded.stop()
    loading.delete(el) // network or parse failure: the next attachAll() retries
    console.error(`[clarusjs] island "${el.getAttribute('c')}" failed to load`, err)
    return
  }
  try {
    attached.set(el, scope(() => {
      // An island with inputs returns how to update them: kept for a parent island that passes new props.
      const update = mod.attach(el, props, state)
      if (typeof update === 'function') updates.set(el, update)
    }))
    el.setAttribute('data-cl-ready', '')
  } catch (err) {
    el.setAttribute('data-cl-error', '') // attach may have wired some listeners already: never retry
    console.error(`[clarusjs] island "${el.getAttribute('c')}" failed to attach`, err)
  } finally {
    loading.delete(el)
  }
  recorded.stop()
  if (el.hasAttribute('data-cl-ready')) replay(recorded.events)
}

/**
 * Attach every island under `root` that isn't attached yet. Resolves once the islands that attach right away
 * (the default, attach="load") are done; idle, visible and interaction islands attach later on their own.
 */
export async function attachAll(root: ParentNode = document, load: Load = lastLoad): Promise<void> {
  lastLoad = load
  // Islands a navigation swap (or a re-render) took out of the document stop running: their effects and listeners
  // are released. Islands kept across a swap stay connected, so they keep running.
  for (const [el, dispose] of attached) {
    if (!el.isConnected) {
      dispose()
      attached.delete(el)
    }
  }
  const islands = [...root.querySelectorAll('cl-island:not([data-cl-ready]):not([data-cl-error])')].filter((el) => !loading.has(el))
  const now: Promise<void>[] = []
  for (const el of islands) {
    loading.add(el)
    const recorded = record(el)
    if ((el.getAttribute('a') ?? 'load') === 'load') now.push(attachOne(el, load, recorded))
    else schedule(el, () => void attachOne(el, load, recorded))
  }
  await Promise.all(now)
}

/**
 * After a navigation (fragment swap or client render): focus moves to the new content, the #hash target, else the
 * page's <h1>, else <main>, so keyboard and screen reader users start there; and the new title is announced in a
 * polite live region. Done here rather than in the router and navigation scripts, which stay within 1 KB.
 */
function arrive(): void {
  let id = ''
  try { id = decodeURIComponent(location.hash.slice(1)) } catch {}
  // In this order: a selector list would return the first match in the document, such as a heading in the header.
  const target = (id && document.getElementById(id)) || document.querySelector('main h1') || document.querySelector('h1') || document.querySelector('main')
  if (target instanceof HTMLElement) {
    // Not natively focusable (a heading, <main>, an <a> without href, whose tabIndex still reads 0): tabindex -1.
    if (!target.matches('a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]')) target.setAttribute('tabindex', '-1')
    target.focus()
  }
  let live = document.getElementById('cl-live')
  if (!live) {
    live = document.createElement('p')
    live.id = 'cl-live'
    live.setAttribute('aria-live', 'polite')
    live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap'
    document.body.append(live)
  }
  // Set after a moment: a region that was just created (the router replaces <body>) must exist before it changes.
  const region = live
  region.textContent = ''
  setTimeout(() => { region.textContent = document.title }, 50)
}

// A parent island re-rendered this nested island with new props (`next`, not in the page): they go to it in place, so
// its DOM and state are kept. False when it can't take them (not attached yet, or another component).
;(globalThis as { __clUpdate?: (el: Element, next: Element) => boolean }).__clUpdate = (el, next) => {
  const update = updates.get(el)
  if (!update || el.getAttribute('c') !== next.getAttribute('c')) return false
  const p = next.getAttribute('p') ?? '{}'
  el.setAttribute('p', p)
  update(parse(p) as Record<string, unknown>)
  return true
}

// Islands inserted later (an @if branch, a @for row, a re-rendered child) are attached through this hook. The router
// and fragment navigation pass navigated = true after replacing the page, and wait for the returned promise: the
// islands that attach right away are attached before afterSwap and afterNavigate run.
;(globalThis as { __clAttach?: (root: ParentNode, navigated?: 1) => Promise<void> }).__clAttach = (root, navigated) => {
  const done = attachAll(root)
  if (navigated) arrive()
  return done
}


if (typeof document !== 'undefined') {
  // Islands never affect layout. Installed on the document (not in <head>), so it survives head swaps by the client
  // router; the server also writes it as a <style> for the first paint.
  const sheet = new CSSStyleSheet()
  sheet.replaceSync('cl-island{display:contents}')
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  attachAll()
}
