// IR → client module: `attach(root, props)`. Runs in the browser, only for stateful components.
import type { ComponentIR, IRNode } from './ir.ts'
import { attrValueExpr, componentCall, htmlExpr, tagArg, walk, whichExpr, type Rewriter } from './html-expr.ts'
import { rewriteClient, rewriteClientExpr, wrapExpr, type Signals } from './script.ts'
import { indentScript, inputsLine, renderName } from './shared.ts'

export function emitClient(ir: ComponentIR): string {
  if (!ir.stateful) return 'export {}\n'
  const kinds = new Set(ir.signals.values())
  const all = walk(ir.nodes)
  const hasHoles = all.some((n) => n.kind === 'hole' && n.reactive)
  const hasBlocks = all.some((n) => n.kind === 'if' && n.block >= 0)
  const hasFors = all.some((n) => n.kind === 'for' && n.block >= 0)
  const hasRegions = all.some((n) => n.kind === 'component' && n.region >= 0)
  const rendersHtml = hasBlocks || hasFors || hasRegions
  const used = [
    (kinds.has('state') || kinds.has('input')) && 'state',
    kinds.has('derived') && 'derived',
    kinds.has('shared') && 'shared',
    hasHoles && 'holes as __cl_holes',
    hasHoles && 'text as __cl_text',
    ir.events.length > 0 && 'on as __cl_on',
    all.some((n) => n.kind === 'attr' && n.reactive) && 'attr as __cl_attr',
    hasBlocks && 'block as __cl_block',
    hasFors && 'forBlock as __cl_for',
    hasRegions && 'region as __cl_region',
    all.some((n) => n.kind === 'component' && !!n.models?.length) && 'model as __cl_model',
    kinds.has('model') && 'modelInput as __cl_modelInput',
    // Branch and row HTML is rendered in the browser with the same helpers as on the server.
    rendersHtml && 'escape as __cl_escape',
    rendersHtml && all.some((n) => n.kind === 'attr') && 'attrHtml as __cl_attrHtml',
    rendersHtml && hasBlocks && 'blockHtml as __cl_blockHtml',
    rendersHtml && hasFors && 'forHtml as __cl_forHtml',
    hasRegions && 'regionHtml as __cl_regionHtml',
  ].filter(Boolean)

  let out = used.length ? `import { ${used.join(', ')} } from 'clarusjs/runtime'\n` : ''
  // Child components render in the browser too (in branches, rows and regions): import their server render
  // functions through the plugin's ?render query.
  const usedComponents = new Set(all.flatMap((n) => (n.kind === 'component' ? [n.name] : [])))
  for (const imp of ir.imports) {
    if (usedComponents.has(imp.name)) out += `import { render as ${renderName(imp.name)} } from '${imp.from}?render'\n`
  }
  for (const d of ir.dataImports) out += `import ${d.clause} from '${d.from}'\n`
  for (const line of ir.scriptImports) out += `${line}\n`
  out += `\nexport function attach(__cl_root, __cl_props = {}, __cl_state) {\n`
  // Inputs: read-only signals (writes are compile errors), set from props now and by the returned update.
  const inputs = ir.inputs.filter((i) => ir.signals.get(i.name) === 'input' || ir.signals.get(i.name) === 'model')
  const value = (i: (typeof inputs)[number], from: string) =>
    i.default === undefined ? `${from}.${i.name}` : `${from}.${i.name} === undefined ? (${rewriteClientExpr(i.default, ir.signals)}) : ${from}.${i.name}`
  // A @model input writes to the parent island (a cl:model event); new props set it with own().
  for (const i of inputs) {
    out += i.model
      ? `  const ${i.name} = __cl_modelInput(__cl_root, ${JSON.stringify(i.name)}, ${value(i, '__cl_props')})\n`
      : `  const ${i.name} = state(${value(i, '__cl_props')})\n`
  }
  out += inputsLine({ ...ir, inputs: ir.inputs.filter((i) => !inputs.includes(i)) })
  if (ir.script) out += indentScript(rewriteClient(ir.script, ir.signals, { stateFromServer: true }))
  const lines = wiring(ir, ir.nodes, undefined, '__cl_root', ir.signals, 0)
  if (lines.length) out += '\n' + lines.map((l) => `  ${l}\n`).join('')
  // New props from a parent island: each input follows (the loader keeps this, and the parent calls it in place).
  if (inputs.length) out += `  return (__cl_p) => {\n${inputs.map((i) => `    ${i.name}.${i.model ? 'own' : 'set'}(${value(i, '__cl_p')})\n`).join('')}  }\n`
  return out + '}\n'
}

/** Rewrites expressions for the browser: reads of `signals` become `.get()`. */
function rewriter(signals: Signals): Rewriter {
  return {
    expr: (e) => rewriteClientExpr(e, signals),
    without: (names) => rewriter(new Map([...signals].filter(([name]) => !names.includes(name)))),
  }
}

/**
 * Code that wires one scope: the top level, an @if branch, a @for row or @empty content. Holes, attributes and
 * events directly in `nodes` are wired here; nested blocks and lists get their own calls, whose branches and rows
 * wire themselves. `ctx` names the island (top level) or the row range the scope's markers are looked up in.
 */
function wiring(ir: ComponentIR, nodes: IRNode[], scope: string | undefined, ctx: string, signals: Signals, depth: number): string[] {
  const rw = rewriter(signals)
  const lines: string[] = []
  const holes = nodes.filter((n) => n.kind === 'hole' && n.reactive) as Extract<IRNode, { kind: 'hole' }>[]
  if (holes.length) lines.push(`const __cl_h = __cl_holes(${ctx})`)
  for (const h of [...holes].sort((a, b) => a.index - b.index)) lines.push(`__cl_text(__cl_h[${h.index}], () => ${wrapExpr(rw.expr(h.expr))})`)
  for (const a of nodes) {
    if (a.kind === 'attr' && a.reactive) lines.push(`__cl_attr(${ctx}, ${a.index}, ${JSON.stringify(a.name)}, () => ${attrValueExpr(a.value, rw.expr)}${tagArg(a)})`)
  }
  for (const e of ir.events.filter((ev) => ev.scope === scope)) {
    const body = rewriteClient(e.handler, signals).trim()
    const end = body.includes('//') ? '\n  ' : ' ' // a trailing line comment must not swallow the closing `})`
    lines.push(`__cl_on(${ctx}, ${e.index}, ${JSON.stringify(e.type)}, ($event) => { ${body}${end}})`)
  }
  const fn = (args: string, inner: string[]) =>
    inner.length ? `(${args}) => {\n${inner.map((l) => `      ${l}`).join('\n')}\n    }` : `(${args}) => {}`
  for (const n of nodes) {
    if (n.kind === 'component' && n.region >= 0) {
      const content = [...n.children, ...n.fills.flatMap((f) => f.nodes)]
      lines.push(`__cl_region(${ctx}, ${n.region}, () => ${componentCall(n, rw)}, ${fn('', wiring(ir, content, `c${n.region}`, ctx, signals, depth))})`)
      // [(x)]: the child island's writes to its @model x come back here and update this island's state.
      for (const m of n.models ?? []) lines.push(`__cl_model(${ctx}, ${n.region}, ${JSON.stringify(m.name)}, (__cl_v) => { ${rewriteClient(m.set, signals).trim()} })`)
    }
    if (n.kind === 'if' && n.block >= 0) {
      const branches = n.branches.map((b, i) =>
        `    { html: () => ${htmlExpr(b.nodes, rw)}, wire: ${fn('', wiring(ir, b.nodes, `${n.block}.${i}`, ctx, signals, depth))} },`)
      lines.push(`__cl_block(${ctx}, ${n.block}, () => ${whichExpr(n, rw)}, [\n${branches.join('\n')}\n  ])`)
    }
    if (n.kind === 'for' && n.block >= 0) {
      // In row HTML `item` and `$index` are plain values; while wiring a row they are that row's signals.
      const rowCtx = `__cl_c${depth + 1}`
      const loop = [n.item, '$index']
      const rowSignals: Signals = new Map([...signals, ...loop.map((name) => [name, 'state'] as const)])
      const plain = rw.without(loop)
      const key = n.track === null ? '$index' : wrapExpr(plain.expr(n.track))
      const row = `{\n    html: (${n.item}, $index) => ${htmlExpr(n.nodes, plain)},\n    wire: ${fn(`${rowCtx}, ${n.item}, $index`, wiring(ir, n.nodes, `f${n.block}`, rowCtx, rowSignals, depth + 1))},\n  }`
      const empty = n.empty
        ? `{\n    html: () => ${htmlExpr(n.empty, rw)},\n    wire: ${fn(rowCtx, wiring(ir, n.empty, `f${n.block}e`, rowCtx, signals, depth + 1))},\n  }`
        : 'null'
      lines.push(`__cl_for(${ctx}, ${n.block}, () => ${wrapExpr(rw.expr(n.list))}, (${n.item}, $index) => ${key}, ${row}, ${empty})`)
    }
  }
  return lines
}
