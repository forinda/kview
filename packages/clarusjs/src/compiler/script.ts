// <script> analysis and signal rewrites. Reads `count` → `count.get()`, writes `count++` → `count.set(count.get() + 1)`.
import { parse as acornParse, parseExpressionAt } from 'acorn'
import { ClarusError } from './errors.ts'

// state(): local state; derived(): computed; shared(store): a local name for a store's signal (see runtime/signals.ts).
// input: an @input of an island, a read-only signal its parent updates (see runtime: attach returns an update).
export type Signals = Map<string, 'state' | 'derived' | 'shared' | 'input'>

// Minimal ESTree node view; acorn produces ESTree with start/end offsets.
type N = { type: string; start: number; end: number; [key: string]: any }
type Hook = (node: N, parent: N | null, key: string) => string | undefined

const OPTS = { ecmaVersion: 'latest', sourceType: 'module' } as const

function isNode(v: unknown): v is N {
  return !!v && typeof (v as N).type === 'string' && typeof (v as N).start === 'number'
}

// Child slots that hold names, not reads.
function isBinding(parent: N | null, key: string): boolean {
  if (!parent) return false
  switch (parent.type) {
    case 'MemberExpression': return key === 'property' && !parent.computed
    case 'Property': case 'MethodDefinition': case 'PropertyDefinition': return key === 'key' && !parent.computed
    case 'VariableDeclarator': return key === 'id'
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': return key === 'id' || key === 'params'
    case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': return key === 'label'
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ExportSpecifier': return true
  }
  return false
}

// Print `node` from `code`, replacing any subtree for which `hook` returns a string.
function print(node: N, code: string, hook: Hook, parent: N | null = null, key = ''): string {
  const replaced = hook(node, parent, key)
  if (replaced !== undefined) return replaced
  const kids: { node: N; key: string }[] = []
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) for (const c of v) { if (isNode(c)) kids.push({ node: c, key: k }) }
    else if (isNode(v) && k !== 'loc') kids.push({ node: v, key: k })
  }
  kids.sort((a, b) => a.node.start - b.node.start)
  let out = ''
  let pos = node.start
  for (const kid of kids) {
    if (kid.node.start < pos) continue // shorthand property: key and value share a range
    out += code.slice(pos, kid.node.start) + print(kid.node, code, hook, node, kid.key)
    pos = kid.node.end
  }
  return out + code.slice(pos, node.end)
}

function parseScript(code: string, file = '<script>', source = code, offset = 0): N {
  try {
    return acornParse(code, OPTS) as unknown as N
  } catch (e) {
    const pos = (e as { pos?: number }).pos ?? 0
    throw new ClarusError(`script: ${(e as Error).message.replace(/ \(\d+:\d+\)$/, '')}`, file, source, offset + pos)
  }
}

function parseExpr(expr: string): N {
  const ast = parseExpressionAt(expr, 0, OPTS) as unknown as N
  // acorn drops wrapping parens from the node range: `({ a })` gives a node ending before `)`. Allow exactly those.
  const open = (expr.slice(0, ast.start).match(/\(/g) ?? []).length
  if (!/^[\s(]*$/.test(expr.slice(0, ast.start)) || expr.slice(ast.end).replace(/\s/g, '') !== ')'.repeat(open)) {
    throw Object.assign(new SyntaxError('expected a single expression'), { pos: ast.end })
  }
  return ast
}

function located<T>(fn: () => T, what: string, file: string, source: string, offset: number): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof ClarusError) throw e
    throw new ClarusError(`${what}: ${(e as Error).message.replace(/ \(\d+:\d+\)$/, '')}`, file, source, offset)
  }
}

/** Throw a located ClarusError unless `expr` is exactly one JS expression. */
export function checkExpr(expr: string, file: string, source: string, offset: number): void {
  located(() => parseExpr(expr), 'invalid expression', file, source, offset)
}

/** Throw a located ClarusError unless `code` parses as statements (event handlers may hold several). */
export function checkHandler(code: string, file: string, source: string, offset: number): void {
  const ast = located(() => acornParse(code, OPTS) as unknown as N, 'invalid event handler', file, source, offset)
  if ((ast.body as N[]).some((n) => n.type === 'ImportDeclaration' || n.type.startsWith('Export'))) {
    throw new ClarusError('imports and exports in event handlers are not supported', file, source, offset)
  }
}

/** Every name bound by a declaration pattern: `a`, `{ a, b: [c] }`, `...rest`, `x = 1`. */
function patternNames(p: N | null | undefined, out: Set<string> = new Set()): Set<string> {
  if (!p) return out
  switch (p.type) {
    case 'Identifier': out.add(p.name); break
    case 'ObjectPattern': for (const prop of p.properties as N[]) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out); break
    case 'ArrayPattern': for (const el of p.elements as (N | null)[]) patternNames(el, out); break
    case 'AssignmentPattern': patternNames(p.left, out); break
    case 'RestElement': patternNames(p.argument, out); break
  }
  return out
}

/** Names a scope node declares for its own body (params, block-level declarations, loop heads, catch params). */
function scopeNames(node: N): Set<string> {
  const names = new Set<string>()
  const declare = (stmt: N) => {
    if (stmt.type === 'VariableDeclaration') for (const d of stmt.declarations as N[]) patternNames(d.id, names)
    else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) names.add(stmt.id.name)
  }
  switch (node.type) {
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
      for (const p of node.params as N[]) patternNames(p, names)
      if (node.type === 'FunctionExpression' && node.id) names.add(node.id.name)
      if (node.body.type === 'BlockStatement') (node.body.body as N[]).forEach(declare)
      break
    case 'BlockStatement': (node.body as N[]).forEach(declare); break
    case 'ForStatement': if (node.init) declare(node.init); break
    case 'ForInStatement': case 'ForOfStatement': declare(node.left); break
    case 'CatchClause': patternNames(node.param, names); break
  }
  return names
}

/** [start, end] ranges of template literals in `code`, so formatting never touches their contents. */
export function templateRanges(code: string): [number, number][] {
  const ranges: [number, number][] = []
  print(parseScript(code), code, (node) => {
    if (node.type === 'TemplateLiteral') ranges.push([node.start, node.end])
    return undefined
  })
  return ranges
}

/** Parenthesize expressions whose meaning changes when inlined as an argument or arrow body (`a, b`, `{ … }`). */
export function wrapExpr(expr: string): string {
  const t = parseExpr(expr).type
  return t === 'SequenceExpression' || t === 'ObjectExpression' ? `(${expr})` : expr
}

/** Names declared at the top level of <script>: variables, functions, classes. */
export function scriptNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const stmt of parseScript(code).body as N[]) {
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations as N[]) patternNames(d.id, names)
    } else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) {
      names.add(stmt.id.name)
    } else if (stmt.type === 'ImportDeclaration') {
      for (const spec of stmt.specifiers as N[]) names.add(spec.local.name)
    }
  }
  return names
}

function signalCall(init: N | null | undefined): 'state' | 'derived' | 'shared' | undefined {
  if (init?.type !== 'CallExpression' || init.callee.type !== 'Identifier') return undefined
  const name = init.callee.name
  return name === 'state' || name === 'derived' || name === 'shared' ? name : undefined
}

/**
 * Take the `import` statements out of a <script> so they can go at the top of the compiled modules. Their text is
 * blanked in the body (same length, newlines kept), so positions in the rest of the script don't move.
 * Island scripts are bundled for the browser, so `node:` imports are a build error.
 */
/** Import statements (text and offset in `code`), and the body with them blanked out. */
export function splitImports(code: string, file: string, source: string, offset: number): { imports: { text: string; start: number }[]; body: string } {
  const imports: { text: string; start: number }[] = []
  let body = code
  for (const stmt of parseScript(code, file, source, offset).body as N[]) {
    if (stmt.type !== 'ImportDeclaration') continue
    const from = String(stmt.source.value)
    if (from.startsWith('node:')) {
      throw new ClarusError(`\`${from}\` can't be imported in an island script: the script is bundled for the browser`, file, source, offset + stmt.start)
    }
    imports.push({ text: code.slice(stmt.start, stmt.end), start: stmt.start })
    body = body.slice(0, stmt.start) + code.slice(stmt.start, stmt.end).replace(/[^\n]/g, ' ') + body.slice(stmt.end)
  }
  return { imports, body }
}

// Globals that only exist on a server runtime. An island's script also runs in the browser and its state() values
// are written into the page, so reading these would leak server data (or simply fail in the browser).
const SERVER_GLOBALS = new Set(['process', 'Deno', 'Bun', 'require'])

export function analyzeScript(code: string, file: string, source: string, offset: number): Signals {
  const signals: Signals = new Map()
  const ast = parseScript(code, file, source, offset)
  const declared = scriptNames(code)
  print(ast, code, (node, parent, key) => {
    if (node.type === 'Identifier' && SERVER_GLOBALS.has(node.name) && !declared.has(node.name) && !isBinding(parent, key)) {
      throw new ClarusError(
        `\`${node.name}\` is server-only: an island's script also runs in the browser, and its state and props are sent to the browser in the page`,
        file, source, offset + node.start)
    }
    return undefined
  })
  for (const stmt of ast.body as N[]) {
    if (stmt.type.startsWith('Export')) {
      throw new ClarusError('a <script> cannot export anything', file, source, offset + stmt.start)
    }
    if (stmt.type !== 'VariableDeclaration') continue
    for (const d of stmt.declarations as N[]) {
      const kind = signalCall(d.init)
      if (kind && d.id.type === 'Identifier') signals.set(d.id.name, kind)
    }
  }
  return signals
}

// Scope-aware: a parameter or local that shadows a signal name turns the rewrite off inside that scope.
// ponytail: `var` declared in nested blocks is not hoisted to the function scope here; add if it ever matters
function clientHook(code: string, signals: Signals, entered: WeakSet<N> = new WeakSet()): Hook {
  const hook: Hook = (node, parent, key) => {
    const rec = (n: N) => print(n, code, hook, node, '')
    const isSignal = (n: N) => n.type === 'Identifier' && signals.has(n.name)
    if (!entered.has(node)) {
      const shadowed = [...scopeNames(node)].filter((n) => signals.has(n))
      if (shadowed.length) {
        entered.add(node)
        const inner: Signals = new Map([...signals].filter(([n]) => !shadowed.includes(n)))
        return print(node, code, clientHook(code, inner, entered), parent, key)
      }
    }
    if (node.type === 'VariableDeclaration' && node.kind === 'let' && (node.declarations as N[]).every((d) => signalCall(d.init))) {
      return 'const' + print({ ...node, kind: 'const', start: node.start + 3 }, code, hook, parent, key)
    }
    if (node.type === 'UpdateExpression' && isSignal(node.argument)) {
      const name = node.argument.name
      const op = node.operator[0]
      if (parent?.type === 'ExpressionStatement') return `${name}.set(${name}.get() ${op} 1)` // value unused
      return node.prefix
        ? `(${name}.set(${name}.get() ${op} 1), ${name}.get())`
        : `((__cl_v) => (${name}.set(__cl_v ${op} 1), __cl_v))(${name}.get())`
    }
    if (node.type === 'AssignmentExpression' && isSignal(node.left)) {
      const name = node.left.name
      const right = rec(node.right)
      return node.operator === '='
        ? `${name}.set(${right})`
        : `${name}.set(${name}.get() ${node.operator.slice(0, -1)} (${right}))`
    }
    if (node.type === 'Property' && node.shorthand && isSignal(node.value)) {
      return `${node.key.name}: ${node.value.name}.get()`
    }
    if (isSignal(node) && !isBinding(parent, key)) return `${node.name}.get()`
    return undefined
  }
  return hook
}

/**
 * Rewrite a script (or event handler) for the browser. With `stateFromServer`, each top-level `let x = state(init)`
 * starts from the value the server rendered with (`__cl_state.x`) when there is one, so `init` isn't re-run.
 */
export function rewriteClient(code: string, signals: Signals, options: { stateFromServer?: boolean } = {}): string {
  const ast = parseScript(code)
  const hook = clientHook(code, signals)
  if (!options.stateFromServer) return code.slice(0, ast.start) + print(ast, code, hook) + code.slice(ast.end)
  const topLevel = new Set((ast.body as N[]).filter((n) => n.type === 'VariableDeclaration').flatMap((n) => n.declarations as N[]))
  const withState: Hook = (node, parent, key) => {
    // `let x = state()` becomes `const x = …`; re-print with this hook so the declarators below still see it.
    if (node.type === 'VariableDeclaration' && node.kind === 'let' && (node.declarations as N[]).every((d) => signalCall(d.init))) {
      return 'const' + print({ ...node, kind: 'const', start: node.start + 3 }, code, withState, parent, key)
    }
    if (topLevel.has(node) && node.id.type === 'Identifier' && signals.get(node.id.name) === 'state' && node.init?.arguments?.length) {
      const name = node.id.name
      const init = print(node.init.arguments[0] as N, code, hook)
      return `${name} = state(__cl_state && ${JSON.stringify(name)} in __cl_state ? __cl_state.${name} : ${init})`
    }
    return hook(node, parent, key)
  }
  return code.slice(0, ast.start) + print(ast, code, withState) + code.slice(ast.end)
}

export function rewriteClientExpr(expr: string, signals: Signals): string {
  const ast = parseExpr(expr)
  return expr.slice(0, ast.start) + print(ast, expr, clientHook(expr, signals)) + expr.slice(ast.end)
}

export function rewriteServer(code: string): string {
  const ast = parseScript(code)
  const hook: Hook = (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return undefined
    const arg = node.arguments[0] as N | undefined
    const inner = arg ? print(arg, code, hook) : 'undefined'
    if (node.callee.name === 'state') return `(${inner})`
    if (node.callee.name === 'derived') return `(${inner})()`
    // A store's current value lives across requests on the server; render from its initial value instead, and from
    // a copy, so a render that mutates it can't change what the next request sees.
    if (node.callee.name === 'shared') return `structuredClone((${inner}).initial)`
    return undefined
  }
  return code.slice(0, ast.start) + print(ast, code, hook) + code.slice(ast.end)
}

export function referencesSignal(expr: string, signals: Signals): boolean {
  return referencesNames(expr, new Set(signals.keys()))
}

/** Does `expr` read any of `names`? */
/**
 * Assignments and ++/-- to any of `names` in a script or event handler, skipping places where a local declaration
 * shadows the name: where each written name starts in `code`.
 */
export function writesTo(code: string, names: Set<string>): { name: string; start: number }[] {
  const found: { name: string; start: number }[] = []
  const visit = (active: Set<string>, entered: WeakSet<N>): Hook => (node, parent, key) => {
    if (!entered.has(node)) {
      const shadowed = [...scopeNames(node)].filter((n) => active.has(n))
      if (shadowed.length) {
        entered.add(node)
        print(node, code, visit(new Set([...active].filter((n) => !shadowed.includes(n))), entered), parent, key)
        return ''
      }
    }
    const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : null
    if (target?.type === 'Identifier' && active.has(target.name)) found.push({ name: target.name, start: target.start })
    return undefined
  }
  print(parseScript(code), code, visit(names, new WeakSet()))
  return found
}

export function referencesNames(expr: string, names: Set<string>): boolean {
  let found = false
  print(parseExpr(expr), expr, (node, parent, key) => {
    if (node.type === 'Identifier' && names.has(node.name) && !isBinding(parent, key)) found = true
    if (node.type === 'Property' && node.shorthand && names.has(node.value?.name)) found = true
    return undefined
  })
  return found
}
