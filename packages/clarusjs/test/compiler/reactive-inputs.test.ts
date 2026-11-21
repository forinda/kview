// @vitest-environment happy-dom
// #217: inputs are readonly and reactive, like derived(): an island's inputs update in place when its parent passes
// new props; writing to one is a compile error.
import { afterEach, expect, test } from 'vitest'
import { compile } from '../../src/compiler/index.ts'
import { ClarusError } from '../../src/compiler/errors.ts'
import { attachAll } from '../../src/runtime/loader.ts'
import { importCode } from '../helpers.ts'

const server = (source: string, clientUrl = '/x.js') => compile(source, { file: 'x.tscl', target: 'server', clientUrl }).code
const client = (source: string) => compile(source, { file: 'x.tscl', target: 'client' }).code
const compileError = (source: string): ClarusError => {
  try { client(source) } catch (e) { return e as ClarusError }
  throw new Error('expected compile to throw')
}
afterEach(() => { document.body.innerHTML = '' })

const label = `@input count: number = 0
<script>
  import { effect } from 'clarusjs/runtime'
  let local = state(count)
  const double = derived(() => count * 2)
  effect(() => { count; globalThis.__seen = (globalThis.__seen ?? 0) + 1 })
  function bump() { local++ }
</script>
<p><b class="count">{{ count }}</b> <i class="double">{{ double }}</i> <u class="local">{{ local }}</u> <button (click)="bump()">+</button></p>
`

test('attach returns an update: holes, derived() and effects that read an input follow it; a state() copy is local', async () => {
  const s = await importCode(server(label), 'ri-s')
  const c = await importCode(client(label), 'ri-c')
  document.body.innerHTML = s.render({ count: 1 })
  const island = document.querySelector('cl-island')!
  ;(globalThis as { __seen?: number }).__seen = 0 // the server render ran the script too
  const update = c.attach(island, { count: 1 })
  const text = (sel: string) => island.querySelector(sel)!.textContent
  const seen = () => (globalThis as { __seen?: number }).__seen
  expect([text('.count'), text('.double'), text('.local'), seen()]).toEqual(['1', '2', '1', 1])
  ;(island.querySelector('button') as HTMLElement).click()
  update({ count: 5 })
  expect([text('.count'), text('.double'), text('.local'), seen()]).toEqual(['5', '10', '2', 2])
  update({}) // the default again
  expect(text('.count')).toBe('0')
})

test('writing to an input is a located compile error; a local of the same name may be written', () => {
  expect(compileError('@input count: number = 0\n<script>\n  function f() { count = 5 }\n</script>\n<p>{{ count }}</p>\n').message)
    .toBe("x.tscl:3:18 @input count is read-only: inputs belong to the parent. Copy it to change it here: let local = state(count)")
  expect(compileError('@input count: number = 0\n<script>\n  let x = state(0)\n</script>\n<button (click)="count++">{{ count }} {{ x }}</button>\n').message)
    .toMatch(/^x\.tscl:5:18 @input count is read-only/)
  expect(() => client('@input count: number = 0\n<script>\n  function f() { let count = 1; count = 2; return count }\n  let x = state(0)\n</script>\n<p>{{ count }} {{ x }}</p>\n')).not.toThrow()
})

test('a nested island is updated in place when its parent changes its props: same element, its own state kept', async () => {
  const child = `@input n: number
<script>
  let clicks = state(0)
</script>
<span class="child"><b class="n">{{ n }}</b> <i class="clicks">{{ clicks }}</i> <button class="inc" (click)="clicks++">+</button></span>
`
  const parent = `@import child from './child.tscl'
<script>
  let n = state(1)
</script>
<div><button class="up" (click)="n++">up</button> <child [n]="n" /></div>
`
  const childServer = compile(child, { file: 'child.tscl', target: 'server', clientUrl: '/child.js' }).code
  const deps = { './child.tscl': childServer, './child.tscl?render': childServer }
  const ps = await importCode(compile(parent, { file: 'parent.tscl', target: 'server', clientUrl: '/parent.js' }).code, 'ri-ps', deps)
  const pc = await importCode(compile(parent, { file: 'parent.tscl', target: 'client' }).code, 'ri-pc', deps)
  const cc = await importCode(client(child), 'ri-cc')
  document.body.innerHTML = ps.render({})
  await attachAll(document, async (src) => (src === '/parent.js' ? pc : cc))
  const inner = () => document.querySelector('cl-island[c="child"]')!
  const before = inner()
  ;(document.querySelector('.inc') as HTMLElement).click()
  expect(inner().querySelector('.clicks')!.textContent).toBe('1')
  ;(document.querySelector('.up') as HTMLElement).click()
  expect(inner()).toBe(before) // not replaced
  expect(inner().querySelector('.n')!.textContent).toBe('2')
  expect(inner().querySelector('.clicks')!.textContent).toBe('1') // its own state kept
})
