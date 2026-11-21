// Syntax tree → IR: static HTML chunks, holes (reactive or not), child components, events. Build-time checks live here.
import { ClarusError } from './errors.ts'
import { importNames, type DataImport, type ImportDecl, type InputDecl, type ParsedFile, type TemplateNode } from './parse.ts'
import { analyzeScript, writesTo, checkExpr, checkHandler, referencesNames, scriptNames, splitImports, type Signals } from './script.ts'

export type IRNode =
  | { kind: 'static'; html: string }
  | { kind: 'hole'; expr: string; reactive: boolean; index: number; json?: true } // index = -1 when not reactive; json: JSON-LD
  // children: content for the default slot; fills: content for named slots (@slot('name') { … }).
  // region: inside an island, a component whose props read state or that wraps content gets markers so the browser
  // can re-render it (-1 otherwise).
  | { kind: 'component'; name: string; props: { name: string; expr: string }[]; children: IRNode[]; fills: { name: string; nodes: IRNode[] }[]; region: number; attach?: string }
  // Where a stateless component renders content it is given ('default' or a name); fallback shows when none is given.
  | { kind: 'slot'; name: string; fallback: IRNode[] }
  // A dynamic attribute: [name]="expr" (value) or name="a {{ b }}" (parts, joined into a string).
  | { kind: 'attr'; name: string; value: { expr: string } | { parts: (string | { expr: string })[] }; reactive: boolean; index: number; tag: string }
  // @if / @else. block = -1 outside islands (plain server-side choice); inside an island, the block's marker index.
  | { kind: 'if'; branches: { cond: string | null; nodes: IRNode[] }[]; block: number }
  // @for / @empty. block = -1 outside islands; inside an island, the list's marker index. `item` and `$index` are in
  // scope in `nodes`; `track` (or the index) keys rows.
  | { kind: 'for'; item: string; list: string; track: string | null; nodes: IRNode[]; empty: IRNode[] | null; block: number }
// scope: which @if branch the element is in ("block.branch"); undefined at the top level.
export type IREvent = { index: number; type: string; handler: string; scope?: string }
export type ComponentIR = {
  file: string
  name: string // basename without .tscl
  inputs: InputDecl[]
  imports: ImportDecl[]
  script?: string // without its import statements, which are in scriptImports
  scriptImports: string[]
  dataImports: DataImport[]
  signals: Signals
  stateful: boolean
  nodes: IRNode[]
  events: IREvent[]
}

const ATTACH_MODES = ['load', 'idle', 'visible', 'interaction']
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

export function lower(parsed: ParsedFile, file: string, source: string): ComponentIR {
  const fail = (text: string, at: number): never => { throw new ClarusError(text, file, source, at) }
  const stateful = !!parsed.script
  const split = parsed.script ? splitImports(parsed.script.code, file, source, parsed.script.start) : { imports: [], body: '' }
  const signals: Signals = parsed.script ? analyzeScript(split.body, file, source, parsed.script.start) : new Map()
  // A hole is reactive if it reads anything the script declares: a signal directly, or a function/value that may read one.
  // text()'s effect tracks the real dependencies, so over-marking only costs a pair of comment markers.
  const scriptScope = parsed.script ? new Set([...signals.keys(), ...scriptNames(parsed.script.code)]) : new Set<string>()
  // An island's inputs are read-only signals its parent updates in place: what reads them is reactive, and writing
  // to one is an error (to change a value locally, copy it into state()).
  const inputNames = new Set(stateful ? parsed.inputs.map((i) => i.name).filter((name) => !signals.has(name)) : [])
  for (const name of inputNames) {
    signals.set(name, 'input')
    scriptScope.add(name)
  }
  const readOnly = (name: string, at: number): never =>
    fail(`@input ${name} is read-only: inputs belong to the parent. Copy it to change it here: let local = state(${name})`, at)
  if (parsed.script && inputNames.size) for (const w of writesTo(parsed.script.code, inputNames)) readOnly(w.name, parsed.script.start + w.start)
  for (const d of parsed.dataImports) {
    // In an island the import is bundled for the browser, like a script import.
    if (stateful && d.from.startsWith('node:')) fail(`\`${d.from}\` can't be imported in an island: its imports are bundled for the browser`, d.start)
    if (stateful) for (const name of importNames(d.clause)) scriptScope.add(name)
  }
  const components = new Set(parsed.imports.map((i) => i.name))
  const nodes: IRNode[] = []
  let out = nodes // where lowering writes; switched while lowering a component's children
  const events: IREvent[] = []
  let holeCount = 0
  let eventElementCount = 0
  let attrElementCount = 0
  let blockCount = 0
  let forCount = 0
  let regionCount = 0
  let loopNames = new Set<string>() // @for item and $index names in scope: they make holes inside rows reactive
  let scopeKey: string | undefined // the @if branch being lowered, for events

  const emitStatic = (html: string) => {
    const last = out[out.length - 1]
    if (last?.kind === 'static') last.html += html
    else out.push({ kind: 'static', html })
  }

  for (const input of parsed.inputs) if (input.default !== undefined) checkExpr(input.default, file, source, input.start)

  // Elements whose content is raw text: comment markers inside them would be literal text, not Comment nodes.
  const RAW_TEXT = new Set(['textarea', 'title', 'style'])

  function visit(node: TemplateNode, rawText?: string): void {
    if (node.type === 'text') return emitStatic(node.value)
    if (node.type === 'fill') return fail('@slot only works directly inside a component tag', node.start)
    if (node.type === 'if') {
      const block = stateful ? blockCount++ : -1
      const parent = out
      const parentScope = scopeKey
      const branches = node.branches.map((b, i) => {
        if (b.cond !== null) checkExpr(b.cond, file, source, b.condStart)
        const branchNodes: IRNode[] = []
        out = branchNodes
        if (stateful) scopeKey = `${block}.${i}`
        b.children.forEach((child) => visit(child, rawText))
        return { cond: b.cond, nodes: branchNodes }
      })
      out = parent
      scopeKey = parentScope
      out.push({ kind: 'if', branches, block })
      return
    }
    if (node.type === 'for') {
      checkExpr(node.list, file, source, node.listStart)
      if (node.track !== null) checkExpr(node.track, file, source, node.trackStart)
      const block = stateful ? forCount++ : -1
      const parent = out
      const parentScope = scopeKey
      const parentLoop = loopNames
      const lowerInto = (children: TemplateNode[], key: string, names: Set<string>) => {
        const list: IRNode[] = []
        out = list
        loopNames = names
        if (stateful) scopeKey = key
        children.forEach((child) => visit(child, rawText))
        return list
      }
      const nodes = lowerInto(node.children, `f${block}`, new Set([...parentLoop, node.item, '$index']))
      const empty = node.empty ? lowerInto(node.empty, `f${block}e`, parentLoop) : null
      out = parent
      scopeKey = parentScope
      loopNames = parentLoop
      out.push({ kind: 'for', item: node.item, list: node.list, track: node.track, nodes, empty, block })
      return
    }
    if (node.type === 'raw') return emitStatic(node.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    if (node.type === 'expr') {
      checkExpr(node.expr, file, source, node.start)
      if (node.json) {
        if (stateful) fail('JSON-LD is rendered on the server: put it in a component without a <script> (a layout or page)', node.start)
        out.push({ kind: 'hole', expr: node.expr, reactive: false, index: -1, json: true })
        return
      }
      const reactive = stateful && (referencesNames(node.expr, scriptScope) || referencesNames(node.expr, loopNames))
      if (reactive && rawText) fail(`reactive {{ }} inside <${rawText}> is not supported yet (it cannot hold update markers)`, node.start)
      out.push({ kind: 'hole', expr: node.expr, reactive, index: reactive ? holeCount++ : -1 })
      return
    }
    if (components.has(node.tag)) {
      const props: { name: string; expr: string }[] = []
      let attach: string | undefined
      for (const a of node.attrs) {
        if (a.kind === 'prop') { checkExpr(a.expr, file, source, a.start); props.push({ name: a.name, expr: a.expr }) }
        else if (a.kind === 'static' && a.name === 'attach') {
          // When the island's code loads in the browser (see runtime/loader.ts).
          if (typeof a.value !== 'string' || !ATTACH_MODES.includes(a.value)) fail(`attach must be one of ${ATTACH_MODES.join(', ')}`, a.start)
          attach = a.value as string
        } else fail(`component <${node.tag}> only takes [prop] bindings and attach="…"`, a.start)
      }
      // Content is rendered here, in this component's scope, and handed to the child for its slots.
      const hasContent = node.children.some((c) => c.type !== 'text' || c.value.trim())
      const readsState = props.some((p) => referencesNames(p.expr, scriptScope) || referencesNames(p.expr, loopNames))
      const region = stateful && (hasContent || readsState) ? regionCount++ : -1
      const parentScope = scopeKey
      if (region >= 0) scopeKey = `c${region}`
      const lowerList = (list: TemplateNode[]) => {
        const nodes_: IRNode[] = []
        const parent = out
        out = nodes_
        list.forEach((child) => visit(child, rawText))
        out = parent
        return nodes_
      }
      const fills: { name: string; nodes: IRNode[] }[] = []
      for (const child of node.children) {
        if (child.type !== 'fill') continue
        if (fills.some((f) => f.name === child.name)) fail(`slot "${child.name}" is filled twice`, child.start)
        fills.push({ name: child.name, nodes: lowerList(child.children) })
      }
      const rest = node.children.filter((c) => c.type !== 'fill')
      // Whitespace around @slot blocks is not content for the default slot.
      const children = rest.every((c) => c.type === 'text' && !c.value.trim()) ? [] : lowerList(rest)
      scopeKey = parentScope
      out.push({ kind: 'component', name: node.tag, props, children, fills, region, ...(attach ? { attach } : {}) })
      return
    }
    if (node.tag === 'slot') {
      if (stateful) fail('<slot /> is only supported in components without <script>', node.start)
      let name = 'default'
      for (const a of node.attrs) {
        if (a.kind === 'static' && a.name === 'name' && typeof a.value === 'string' && a.value) name = a.value
        else fail('<slot> only takes name="…"', a.start)
      }
      // Fallback content belongs to this component: its holes read this component's inputs.
      const fallback: IRNode[] = []
      const parent = out
      out = fallback
      node.children.forEach((child) => visit(child, rawText))
      out = parent
      out.push({ kind: 'slot', name, fallback })
      return
    }
    emitStatic(`<${node.tag}`)
    const elementEvents = node.attrs.filter((a) => a.kind === 'event')
    const dynamic: Extract<IRNode, { kind: 'attr' }>[] = []
    for (const a of node.attrs) {
      if (a.kind === 'static') emitStatic(a.value === true ? ` ${a.name}` : ` ${a.name}="${a.value}"`)
      else if (a.kind === 'event') {
        if (!stateful) fail('event bindings need a <script> with state; this component is static', a.start)
        checkHandler(a.expr, file, source, a.start)
        if (inputNames.size) {
          const exprStart = source.indexOf(a.expr, a.start)
          for (const w of writesTo(a.expr, inputNames)) readOnly(w.name, exprStart + w.start)
        }
      } else {
        if (/^on/i.test(a.name)) fail(`use (${a.name.slice(2).toLowerCase()}) for events, not an ${a.name} attribute`, a.start)
        // srcdoc is a whole HTML document: binding data into it is HTML injection, so it stays static.
        if (a.name.toLowerCase() === 'srcdoc') fail('srcdoc cannot be bound; write it as a static attribute', a.start)
        const exprs = a.kind === 'prop' ? [{ expr: a.expr, start: a.start }] : a.parts.filter((p) => typeof p !== 'string')
        for (const e of exprs) checkExpr(e.expr, file, source, e.start)
        const reactive = stateful && exprs.some((e) => referencesNames(e.expr, scriptScope) || referencesNames(e.expr, loopNames))
        const value = a.kind === 'prop' ? { expr: a.expr } : { parts: a.parts.map((p) => (typeof p === 'string' ? p : { expr: p.expr })) }
        const node_ = { kind: 'attr' as const, name: a.name, value, reactive, index: -1, tag: node.tag }
        if (reactive) dynamic.push(node_)
        out.push(node_)
      }
    }
    // One marker per element for its reactive attributes, one for its events.
    if (dynamic.length) {
      const index = attrElementCount++
      for (const d of dynamic) d.index = index
      emitStatic(` data-cl-a="${index}"`)
    }
    if (elementEvents.length) {
      const index = eventElementCount++
      emitStatic(` data-cl-e="${index}"`)
      for (const a of elementEvents) events.push({ index, type: a.name, handler: a.kind === 'event' ? a.expr : '', scope: scopeKey })
    }
    emitStatic('>')
    node.children.forEach((child) => visit(child, RAW_TEXT.has(node.tag) ? node.tag : rawText))
    if (!VOID.has(node.tag)) emitStatic(`</${node.tag}>`)
  }

  parsed.nodes.forEach((n) => visit(n))
  return {
    file,
    name: file.split('/').pop()!.replace(/\.tscl$/, ''),
    inputs: parsed.inputs,
    imports: parsed.imports,
    script: parsed.script ? split.body : undefined,
    scriptImports: split.imports.map((imp) => imp.text),
    dataImports: parsed.dataImports,
    signals,
    stateful,
    nodes,
    events,
  }
}
