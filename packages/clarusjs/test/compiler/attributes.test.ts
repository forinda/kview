// @vitest-environment happy-dom
// #9: dynamic attributes — [attr]="expr" bindings and {{ }} inside attribute values.
import { expect, test } from 'vitest'
import { compile } from '../../src/compiler/index.ts'
import { ClarusError } from '../../src/compiler/errors.ts'
import { importCode } from '../helpers.ts'

async function render(source: string, props = {}) {
  const { render } = await importCode(compile(source, { file: 'x.tscl', target: 'server', clientUrl: '/x' }).code, 'attrs')
  return render(props) as string
}
function compileError(source: string): ClarusError {
  try { compile(source, { file: 'x.tscl', target: 'server', clientUrl: '/x' }) } catch (e) { return e as ClarusError }
  throw new Error('expected compile to throw')
}
async function mount(source: string, props = {}) {
  const server = await importCode(compile(source, { file: 'x.tscl', target: 'server', clientUrl: '/x' }).code, 'attrs-s')
  const client = await importCode(compile(source, { file: 'x.tscl', target: 'client' }).code, 'attrs-c')
  document.body.innerHTML = server.render(props)
  const island = document.querySelector('cl-island')!
  client.attach(island, props)
  return island
}

test('[attr] binds an expression', async () => {
  expect(await render('@input url: string\n<a [href]="url">x</a>', { url: '/guide/islands' })).toBe('<a href="/guide/islands">x</a>')
})

test('bound values are escaped for the attribute', async () => {
  expect(await render('@input t: string\n<b [title]="t">x</b>', { t: `"><script>alert('x')</script>` }))
    .toBe('<b title="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;">x</b>')
})

test('javascript: and vbscript: URLs are refused in URL attributes only', async () => {
  const src = '@input u: string\n<a [href]="u" [title]="u">x</a><img [src]="u">'
  for (const u of ['javascript:alert(1)', '  JaVaScRiPt:alert(1)', 'vbscript:msgbox(1)']) {
    const out = await render(src, { u })
    expect(out).toContain('href="about:invalid#unsafe"')
    expect(out).toContain('src="about:invalid#unsafe"')
    expect(out).toContain(`title="${u.replace(/'/g, '&#39;')}"`)
  }
  expect(await render(src, { u: 'https://example.com/?a=1&b=2' })).toContain('href="https://example.com/?a=1&amp;b=2"')
})

test('true adds a boolean attribute; false, null and undefined remove it', async () => {
  const src = '@input on: unknown\n<button [disabled]="on">x</button>'
  expect(await render(src, { on: true })).toBe('<button disabled>x</button>')
  for (const on of [false, null, undefined]) expect(await render(src, { on })).toBe('<button>x</button>')
})

test('{{ }} inside an attribute value interpolates to a string', async () => {
  const src = `@input slug: string\n@input active: boolean\n<a href="/guide/{{ slug }}" class="nav {{ active ? 'on' : '' }}">x</a>`
  expect(await render(src, { slug: 'a b&c', active: true })).toBe('<a href="/guide/a b&amp;c" class="nav on">x</a>')
  expect(await render(src, { slug: null, active: false })).toBe('<a href="/guide/" class="nav ">x</a>')
})

test('an interpolated URL attribute is checked as a whole', async () => {
  expect(await render('@input u: string\n<a href="{{ u }}">x</a>', { u: 'javascript:alert(1)' })).toBe('<a href="about:invalid#unsafe">x</a>')
})

test('on* attributes are a located build error', () => {
  expect(compileError('@input f: string\n<b [onclick]="f">x</b>').message).toMatch(/^x\.tscl:2:4 .*use \(click\)/)
  expect(compileError('@input f: string\n<b onclick="{{ f }}">x</b>').message).toMatch(/^x\.tscl:2:4 .*use \(click\)/)
})

test('non-reactive attributes in a stateful component get no marker', async () => {
  // A constant never changes. (Inputs of an island are reactive since #217: an attribute reading one has a marker.)
  const out = await render(`<script>let n = state(0)</script>\n<a [href]="'/' + 'a'" (click)="n++">{{ n }}</a>`)
  expect(out).not.toContain('data-cl-a')
  expect(out).toContain('href="/a"')
})

test('attributes that read state update in the browser', async () => {
  const island = await mount(`<script>
  let n = state(0)
  let url = state('/a')
</script>
<a [href]="url" title="clicked {{ n }} times" [data-even]="n % 2 === 0" (click)="n++; url = '/b'">go</a>`)
  const a = island.querySelector('a')!
  expect(a.getAttribute('href')).toBe('/a')
  expect(a.getAttribute('title')).toBe('clicked 0 times')
  expect(a.hasAttribute('data-even')).toBe(true)
  a.click()
  expect(a.getAttribute('href')).toBe('/b')
  expect(a.getAttribute('title')).toBe('clicked 1 times')
  expect(a.hasAttribute('data-even')).toBe(false)
})

test('a reactive URL attribute is still checked in the browser', async () => {
  const island = await mount(`<script>let u = state('/ok')</script>\n<a [href]="u" (click)="u = 'javascript:alert(1)'">go</a>`)
  const a = island.querySelector('a')!
  a.click()
  expect(a.getAttribute('href')).toBe('about:invalid#unsafe')
})

test('URL attributes allow only safe schemes (allowlist)', async () => {
  const src = '@input u: string\n<a [href]="u">x</a>'
  for (const ok of ['/guide/x', '../x', '#top', '?q=1', 'https://example.com', 'http://example.com', 'mailto:a@b.c', 'tel:+123']) {
    expect(await render(src, { u: ok }), ok).toContain(`href="${ok}"`)
  }
  for (const bad of ['data:text/html,<script>alert(1)</script>', 'ftp://x', 'file:///etc/passwd', 'blob:https://x/y', 'jav\tascript:alert(1)']) {
    expect(await render(src, { u: bad }), bad).toContain('href="about:invalid#unsafe"')
  }
})

test('raster data: images are allowed for image attributes only', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='
  expect(await render('@input u: string\n<img [src]="u">', { u: png })).toContain(`src="${png}"`)
  expect(await render('@input u: string\n<img [src]="u">', { u: 'data:image/svg+xml,<svg onload=alert(1)>' })).toContain('src="about:invalid#unsafe"')
  expect(await render('@input u: string\n<a [href]="u">x</a>', { u: png })).toContain('href="about:invalid#unsafe"')
})

test('more URL-bearing attributes are checked', async () => {
  for (const name of ['data', 'codebase', 'ping', 'manifest', 'longdesc']) {
    expect(await render(`@input u: string\n<x-el [${name}]="u"></x-el>`, { u: 'javascript:alert(1)' }), name).toContain(`${name}="about:invalid#unsafe"`)
  }
})

test('SVG animation attributes are URL-checked on animation elements only', async () => {
  for (const tag of ['animate', 'set', 'animateMotion', 'animateTransform']) {
    for (const name of ['to', 'from', 'values', 'by']) {
      expect(await render(`@input u: string\n<${tag} [${name}]="u" />`, { u: 'javascript:alert(1)' }), `${tag} ${name}`).toContain(`${name}="about:invalid#unsafe"`)
    }
  }
  // Elsewhere they are ordinary data, even when they look like a scheme.
  const out = await render(`<x-slider [values]="'ready;status:active'" [from]="'status:active'" [to]="10" [by]="2"></x-slider>`)
  expect(out).toBe('<x-slider values="ready;status:active" from="status:active" to="10" by="2"></x-slider>')
})

test('srcset checks every candidate', async () => {
  const src = '@input s: string\n<img [srcset]="s">'
  expect(await render(src, { s: '/a.png 1x, /b.png 2x' })).toContain('srcset="/a.png 1x, /b.png 2x"')
  expect(await render(src, { s: '/a.png 1x, javascript:alert(1) 2x' })).toContain('srcset="about:invalid#unsafe"')
})

test('binding srcdoc is a located build error', () => {
  expect(compileError('@input h: string\n<iframe [srcdoc]="h"></iframe>').message).toMatch(/^x\.tscl:2:9 .*srcdoc/)
  expect(compileError('@input h: string\n<iframe srcdoc="{{ h }}"></iframe>').message).toMatch(/^x\.tscl:2:9 .*srcdoc/)
})

test('list-valued URL attributes check every entry (values by ";", ping by whitespace)', async () => {
  expect(await render('@input v: string\n<animate [values]="v" />', { v: '/a;/b' })).toContain('values="/a;/b"')
  expect(await render('@input v: string\n<animate [values]="v" />', { v: '/ok;javascript:alert(1)' })).toContain('values="about:invalid#unsafe"')
  expect(await render('@input p: string\n<a [ping]="p">x</a>', { p: '/track https://x.example/t' })).toContain('ping="/track https://x.example/t"')
  expect(await render('@input p: string\n<a [ping]="p">x</a>', { p: '/track javascript:alert(1)' })).toContain('ping="about:invalid#unsafe"')
})

test('in the browser, SVG animation attributes are also checked only on animation elements', async () => {
  const island = await mount(`<script>
  let v = state('ready;status:active')
  let u = state('/ok')
</script>
<x-slider [values]="v"></x-slider><animate [values]="u" /><b (click)="v = 'next;status:done'; u = '/ok;javascript:alert(1)'">go</b>`)
  ;(island.querySelector('b') as HTMLElement).click()
  expect(island.querySelector('x-slider')!.getAttribute('values')).toBe('next;status:done')
  expect(island.querySelector('animate')!.getAttribute('values')).toBe('about:invalid#unsafe')
})
