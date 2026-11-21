// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { beforeEach, expect, test } from 'vitest'
import { compile } from '../../src/compiler/index.ts'
import { importCode } from '../helpers.ts'

const fixture = (name: string) => readFileSync(`${import.meta.dirname}/../fixtures/${name}`, 'utf8')
const URL_ = '/src/components/counter.tscl?import'

async function load(name: string) {
  const source = fixture(`${name}.tscl`)
  const server = await importCode(compile(source, { file: `${name}.tscl`, target: 'server', clientUrl: URL_ }).code, `${name}-s`)
  const client = await importCode(compile(source, { file: `${name}.tscl`, target: 'client' }).code, `${name}-c`)
  return { render: server.render, attach: client.attach }
}
const islands = () => [...document.querySelectorAll('cl-island')]

beforeEach(() => { document.body.innerHTML = '' })

test('counter client output is readable and exact', () => {
  expect(compile(fixture('counter.tscl'), { file: 'counter.tscl', target: 'client' }).code).toBe(
`import { state, derived, holes as __cl_holes, text as __cl_text, on as __cl_on } from 'clarusjs/runtime'

export function attach(__cl_root, __cl_props = {}, __cl_state) {
  const start = state(__cl_props.start === undefined ? (0) : __cl_props.start)
  const count = state(__cl_state && "count" in __cl_state ? __cl_state.count : start.get())
  const double = derived(() => count.get() * 2)
  function add() { count.set(count.get() + 1) }

  const __cl_h = __cl_holes(__cl_root)
  __cl_text(__cl_h[0], () => count.get())
  __cl_text(__cl_h[1], () => double.get())
  __cl_on(__cl_root, 0, "click", ($event) => { add() })
  return (__cl_p) => {
    start.set(__cl_p.start === undefined ? (0) : __cl_p.start)
  }
}
`)
})

test('stateless component compiles to an empty client module', () => {
  expect(compile(fixture('greeting.tscl'), { file: 'greeting.tscl', target: 'client' })).toEqual({ code: 'export {}\n', stateful: false, css: '' })
})

test('attach wires server HTML without re-rendering it', async () => {
  const { render, attach } = await load('counter')
  document.body.innerHTML = render({ start: 3 })
  const [island] = islands()
  const button = island!.querySelector('button')!
  const textNode = [...button.childNodes].find((n) => n.nodeType === 3 && n.textContent === '3')!
  attach(island, { start: 3 })
  button.click()
  expect(button.textContent).toBe('Clicked 4 times (double: 8)')
  expect(island!.querySelector('button')).toBe(button)
  expect(textNode.textContent).toBe('4')
  expect(textNode.parentNode).toBe(button)
})

test('a hole that starts empty still updates', async () => {
  const { render, attach } = await load('label')
  const html = render()
  expect(html).toContain('<!--[0--><!--]-->')
  document.body.innerHTML = html
  const [island] = islands()
  attach(island, {})
  island!.querySelector('span')!.click()
  expect(island!.querySelector('span')!.textContent).toBe('hi')
})

test('two islands of the same component are independent', async () => {
  const { render, attach } = await load('counter')
  document.body.innerHTML = render({ start: 1 }) + render({ start: 10 })
  const [a, b] = islands()
  attach(a, { start: 1 })
  attach(b, { start: 10 })
  a!.querySelector('button')!.click()
  a!.querySelector('button')!.click()
  expect(a!.textContent).toBe('Clicked 3 times (double: 6)')
  expect(b!.textContent).toBe('Clicked 10 times (double: 20)')
})

test('#14: attach uses the state the server rendered instead of re-running initial values', async () => {
  const source = `<script>
  let started = state(Date.now())
  let n = state(0)
  const later = derived(() => started + n)
</script>
<b (click)="n++">{{ started }}|{{ later }}</b>`
  const server = await importCode(compile(source, { file: 'clock.tscl', target: 'server', clientUrl: '/c' }).code, 'clock-s')
  const client = await importCode(compile(source, { file: 'clock.tscl', target: 'client' }).code, 'clock-c')
  const realNow = Date.now
  Date.now = () => 1000
  document.body.innerHTML = server.render()
  Date.now = () => 5000
  try {
    const island = document.querySelector('cl-island')!
    expect(island.getAttribute('s')).toBe('{"started":1000,"n":0}')
    const { parse } = await import('../../src/runtime/serialize.ts')
    client.attach(island, parse(island.getAttribute('p')!), parse(island.getAttribute('s')!))
    expect(island.querySelector('b')!.textContent).toBe('1000|1000')
    island.querySelector('b')!.click()
    expect(island.querySelector('b')!.textContent).toBe('1000|1001')
  } finally {
    Date.now = realNow
  }
})

test('#14: without server state, attach still computes initial values', async () => {
  const { attach } = await load('counter')
  document.body.innerHTML = '<cl-island><button data-cl-e="0">Clicked <!--[0-->5<!--]--> times (double: <!--[1-->10<!--]-->)</button></cl-island>'
  attach(document.querySelector('cl-island'), { start: 5 })
  document.querySelector('button')!.click()
  expect(document.querySelector('button')!.textContent).toBe('Clicked 6 times (double: 12)')
})
