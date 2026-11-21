// #21: `clarusjs check` type-checks a project's .tscl files and reports file.tscl:line:col.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../src/cli/check.ts'

function project(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'clarus-cli-'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, file)), { recursive: true })
    writeFileSync(resolve(root, file), text)
  }
  return root
}
const typescript = resolve(import.meta.dirname, '../../node_modules/typescript')

test('a clean project passes', () => {
  const root = project({
    'src/components/badge.tscl': '@input label: string\n<b>{{ label }}</b>\n',
    'src/pages/index.tscl': `@import badge from '../components/badge.tscl'\n<badge [label]="'hi'" />\n`,
  })
  const result = check({ root, typescript })
  expect(result.diagnostics).toEqual([])
  expect(result.exitCode).toBe(0)
})

test('errors are reported per template position, with a text and a JSON form', () => {
  const root = project({
    'src/domain/user.ts': 'export interface User { name: string }\n',
    'src/pages/index.tscl': `@import type { User } from '../domain/user'\n@input user: User\n<h1>{{ user.nmae }}</h1>\n`,
  })
  const result = check({ root, typescript })
  expect(result.exitCode).toBe(1)
  expect(result.diagnostics).toEqual([
    { file: 'src/pages/index.tscl', line: 3, column: 13, code: 'TS2339', message: expect.stringContaining("Property 'nmae' does not exist") },
  ])
  expect(result.text).toMatch(/^src\/pages\/index\.tscl:3:13 error TS2339: Property 'nmae' does not exist/m)
  expect(JSON.parse(result.json)).toEqual(result.diagnostics)
})

test('template syntax errors are reported the same way', () => {
  const root = project({ 'src/pages/index.tscl': '<p>a</p>\n<div>\n  <span>\n' })
  const result = check({ root, typescript })
  expect(result.exitCode).toBe(1)
  expect(result.diagnostics).toEqual([expect.objectContaining({ file: 'src/pages/index.tscl', line: 3, column: 3, code: 'clarus', message: expect.stringContaining('unclosed <span>') })])
})

test('errors in plain .ts files of the project are reported too', () => {
  const root = project({
    'src/stores/n.ts': 'export const n: number = "x"\n',
    'src/pages/index.tscl': '<p>ok</p>\n',
  })
  const result = check({ root, typescript })
  expect(result.diagnostics).toEqual([expect.objectContaining({ file: 'src/stores/n.ts', line: 1, column: 14, code: 'TS2322' })])
})

test('untyped parameters in island scripts are fine (scripts are JavaScript)', () => {
  const root = project({
    'src/components/c.tscl': `<script>\n  let xs = state([1])\n  function remove(x) { xs = xs.filter((i) => i !== x) }\n</script>\n<b (click)="remove(1)">{{ xs.length }}</b>\n`,
  })
  expect(check({ root, typescript }).diagnostics).toEqual([])
})

test('a project tsconfig is extended', () => {
  const root = project({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } }),
    'src/pages/index.tscl': '@input xs: string[]\n<p>{{ xs[0].length }}</p>\n',
  })
  expect(check({ root, typescript }).diagnostics).toEqual([expect.objectContaining({ file: 'src/pages/index.tscl', line: 2, column: 7 })])
})

test('the command line runs check, with --json and an exit code', async () => {
  const { spawnSync } = await import('node:child_process')
  const root = project({ 'src/pages/index.tscl': '@input n: number\n<p>{{ n.foo }}</p>\n' })
  const cli = resolve(import.meta.dirname, '../../src/cli/index.ts')
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, 'check', root, '--json'], { encoding: 'utf8' })
  expect(run.status).toBe(1)
  expect(JSON.parse(run.stdout)).toEqual([expect.objectContaining({ file: 'src/pages/index.tscl', line: 2, column: 9, code: 'TS2339' })])
  const help = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, '--help'], { encoding: 'utf8' })
  expect(help.stdout).toMatch(/check \[options\] \[dir\]/)
})

test('#23: the type-checking guide shows the real output for its example', () => {
  const guide = readFileSync(resolve(import.meta.dirname, '../../../docs/src/pages/guide/type-checking.md'), 'utf8')
  const sample = guide.match(/\{\{-- src\/pages\/index\.tscl --\}\}\n([\s\S]*?)\n```/)![1]!
  const shown = guide.match(/\$ pnpm check\n([\s\S]*?)\n```/)![1]!
  const root = project({ 'src/nav.ts': `export const nav = [{ title: 'Intro', href: '/intro' }]\n`, 'src/pages/index.tscl': `${sample}\n` })
  const result = check({ root, typescript })
  expect(shown).toBe(`${result.text}\n\n${result.diagnostics.length} error`)
})

test('#31: what load() returns is checked against the page inputs', () => {
  const page = '@input name: string\n@input count: number = 0\n<p>{{ name }} {{ count }}</p>\n'
  const ok = project({
    'src/pages/users/[id].tscl': page,
    'src/pages/users/[id].load.ts': 'export async function load({ params }: { params: Record<string, string> }) {\n  return { name: params.id ?? "" }\n}\n',
  })
  expect(check({ root: ok, typescript }).diagnostics).toEqual([])
  const bad = project({
    'src/pages/users/[id].tscl': page,
    'src/pages/users/[id].load.ts': 'export function load() {\n  return { name: 42 }\n}\n',
  })
  expect(check({ root: bad, typescript }).diagnostics).toEqual([
    { file: 'src/pages/users/[id].tscl', line: 1, column: 1, code: 'TS2322', message: expect.stringMatching(/^load\(\) returns a value that doesn.t fit this page.s inputs: .*not assignable/s) },
  ])
})

test('#192: a load() that may return a Response (a redirect) has only its page inputs checked', () => {
  const page = '@input name: string\n<p>{{ name }}</p>\n'
  const loader = (value: string) => `export function load({ request }: { request: Request }) {\n  if (request.url.endsWith('?x')) return new Response(null, { status: 302, headers: { location: '/' } })\n  return { name: ${value} }\n}\n`
  expect(check({ root: project({ 'src/pages/a.tscl': page, 'src/pages/a.load.ts': loader('"a"') }), typescript }).diagnostics).toEqual([])
  expect(check({ root: project({ 'src/pages/a.tscl': page, 'src/pages/a.load.ts': loader('1') }), typescript }).diagnostics).toEqual([
    { file: 'src/pages/a.tscl', line: 1, column: 1, code: 'TS2322', message: expect.stringMatching(/^load\(\) returns a value that doesn.t fit/) },
  ])
})

test('#184: href() is typed against the routes through the generated routes.d.ts: a wrong route or a missing param is an error', () => {
  const root = project({
    'src/pages/index.tscl': '<p>home</p>\n',
    'src/pages/guide/holes.md': '# Holes\n',
    'src/pages/releases/[version].tscl': '@input version: string\n<h1>{{ version }}</h1>\n',
    'src/server/links.ts': [
      "import { href } from 'clarusjs/navigation'",
      "export const ok = [href('/'), href('/guide/holes'), href('/releases/[version]', { version: '0.8.0' })]",
      "export const typo = href('/guid/holes')",
      "export const missing = href('/releases/[version]')",
      '',
    ].join('\n'),
  })
  mkdirSync(resolve(root, 'node_modules'))
  symlinkSync(resolve(import.meta.dirname, '../..'), resolve(root, 'node_modules/clarusjs'), 'dir')
  const result = check({ root, typescript })
  expect(readFileSync(resolve(root, '.clarusjs/routes.d.ts'), 'utf8')).toContain('"/releases/[version]": { version: string }')
  expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual(['src/server/links.ts:3 TS2345', 'src/server/links.ts:4 TS2554'])
})

test('#22: render() is typed against each view\'s inputs through the generated views.d.ts', () => {
  const root = project({
    'src/components/pill.tscl': '@input text: string\n@input tone: "info" | "tip" = "info"\n<b>{{ text }}</b>\n',
    'src/server/mail.ts': [
      "import { render } from 'clarusjs/views'",
      "export const ok = render('components/pill', { text: 'hi', tone: 'tip' })",
      "export const wrongProp = render('components/pill', { text: 1 })",
      "export const unknown = render('components/pil', {})",
      '',
    ].join('\n'),
  })
  // Like an app that installed clarusjs.
  mkdirSync(resolve(root, 'node_modules'))
  symlinkSync(resolve(import.meta.dirname, '../..'), resolve(root, 'node_modules/clarusjs'), 'dir')
  const result = check({ root, typescript })
  expect(existsSync(resolve(root, '.clarusjs/views.d.ts'))).toBe(true)
  expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual(['src/server/mail.ts:3 TS2322', 'src/server/mail.ts:4 TS2345'])
})

test('review: views.d.ts is declarations only, so an app tsconfig can include it (noImplicitAny on, relative type imports)', async () => {
  const { spawnSync } = await import('node:child_process')
  const root = project({
    'src/domain/user.ts': 'export interface User { name: string }\n',
    // A JavaScript script with an untyped parameter, and an input typed through a relative @import type.
    'src/components/card.tscl': "@import type { User } from '../domain/user'\n@input user: User\n<script>\n  let n = state(0)\n  function bump(x) { n = n + x }\n</script>\n<b (click)=\"bump(1)\">{{ user.name }} {{ n }}</b>\n",
    'src/server/mail.ts': "import { render } from 'clarusjs/views'\nexport const ok = render('components/card', { user: { name: 'Ada' } })\nexport const bad = render('components/card', { user: { nam: 'Ada' } })\n",
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noImplicitAny: true, noEmit: true, target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', allowImportingTsExtensions: true, skipLibCheck: true }, include: ['src', '.clarusjs/views.d.ts'] }),
  })
  mkdirSync(resolve(root, 'node_modules'))
  symlinkSync(resolve(import.meta.dirname, '../..'), resolve(root, 'node_modules/clarusjs'), 'dir')
  check({ root, typescript })
  const registry = readFileSync(resolve(root, '.clarusjs/views.d.ts'), 'utf8')
  expect(registry).not.toContain('virtual/')
  // The app's own tsc, with its own strict settings: only the deliberate mistake is reported.
  const bin = JSON.parse(readFileSync(resolve(typescript, 'package.json'), 'utf8')).bin
  const tsc = resolve(typescript, typeof bin === 'string' ? bin : bin.tsc)
  const run = spawnSync(process.execPath, [tsc, '-p', root, '--pretty', 'false'], { cwd: root, encoding: 'utf8' })
  const errors = run.stdout.split('\n').filter((l) => l.includes('error TS'))
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/^src\/server\/mail\.ts\(3,.*'nam' does not exist/)
})

test('#161: components from packages are type-checked where they are used (their own imports resolve too)', () => {
  const root = project({
    'node_modules/fake-theme/package.json': JSON.stringify({ name: 'fake-theme', type: 'module', exports: { './*': './src/*' } }),
    'node_modules/fake-theme/src/types.ts': 'export type Config = { name: string }\n',
    'node_modules/fake-theme/src/badge.tscl': '@input count: number\n<b>{{ count }}</b>\n',
    'node_modules/fake-theme/src/layout.tscl': "@import badge from './badge.tscl'\n@import type { Config } from './types.ts'\n@input config: Config\n<main><badge [count]=\"1\" />{{ config.name }}<slot /></main>\n",
    'src/pages/index.tscl': "@import layout from 'fake-theme/layout.tscl'\n@import badge from 'fake-theme/badge.tscl'\n<layout [config]=\"{ name: 'x' }\"><badge [count]=\"'three'\" /></layout>\n",
  })
  const result = check({ root, typescript })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual(['src/pages/index.tscl:3 TS2322'])
})

test('a JavaScript project\'s jsconfig.json is used like a tsconfig.json', () => {
  const root = project({ 'jsconfig.json': JSON.stringify({ compilerOptions: { strict: true, lib: ['ES2023', 'DOM'] } }), 'src/pages/index.tscl': '<p>hi</p>\n' })
  check({ root, typescript })
  expect(JSON.parse(readFileSync(resolve(root, '.clarusjs/tsconfig.check.json'), 'utf8')).extends).toBe('../jsconfig.json')
})

test('#102: ~/ and tsconfig paths resolve in templates (components, data) as in the build; errors stay in the template', () => {
  const root = project({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'DOM'], allowImportingTsExtensions: true, noEmit: true, paths: { '@/*': ['./src/*'] } } }),
    'src/components/card.tscl': '@input title: string\n<b>{{ title }}</b>\n',
    'src/data/site.ts': "export const name: string = 'x'\n",
    'src/pages/index.tscl': "@import card from '~/components/card.tscl'\n@import { name } from '@/data/site.ts'\n<card [title]=\"name\" />\n<p>{{ name.nope }}</p>\n",
  })
  const result = check({ root, typescript })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual(['src/pages/index.tscl:4 TS2339'])
})

// #142: page sources (Markdown and the like) are checked too, with errors at the source file's own line.
// A tiny source: its first line is a title the page drops; the rest is template text, passed through.
const pageSource = { extension: '.page', toTscl: (code: string) => `<h1>generated</h1>\n${code.split('\n').slice(1).join('\n')}` }

test('#142: a page source\'s mistyped component prop is reported at file.page:line:col, like the same .tscl page', () => {
  const page = "@import note from '../components/note.tscl'\n<p>intro</p>\n<note [count]=\"'x'\" />\n"
  const root = project({
    'src/components/note.tscl': '@input count: number\n<b>{{ count }}</b>\n',
    'src/pages/as-page.page': `Title line\n${page}`,
    'src/pages/as-tscl.tscl': page,
    'src/notes/ignored.page': 'Not under src/pages: not a page\n<note [count]="1" />\n',
  })
  const result = check({ root, typescript, sources: [pageSource] })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line}:${d.column} ${d.code}`)).toEqual([
    'src/pages/as-page.page:4:8 TS2322', // the same place as in the .tscl page, one line down (the title line)
    'src/pages/as-tscl.tscl:3:8 TS2322',
  ])
})

test('#142: a page source\'s .load.ts is paired with it, and its views are in the registry', () => {
  const root = project({
    'src/pages/data.page': 'Title\n@input name: string\n<p>{{ name }}</p>\n',
    'src/pages/data.load.ts': 'export function load() {\n  return { name: 42 }\n}\n',
  })
  const result = check({ root, typescript, sources: [pageSource] })
  expect(result.diagnostics.map((d) => `${d.file} ${d.code}`)).toEqual(['src/pages/data.page TS2322'])
  expect(readFileSync(resolve(root, '.clarusjs/views.d.ts'), 'utf8')).toContain('"pages/data"')
})

test('#213: an unknown prop on a component without inputs is an error, like on one with inputs', () => {
  const root = project({
    'src/components/plain.tscl': '<p>plain</p>\n',
    'src/components/with.tscl': '@input label: string\n<p>{{ label }}</p>\n',
    'src/pages/index.tscl': "@import plain from '../components/plain.tscl'\n@import withInput from '../components/with.tscl'\n<plain [speed]=\"1\" />\n<withInput [label]=\"'x'\" [speed]=\"1\" />\n<plain />\n",
  })
  const result = check({ root, typescript })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line}:${d.column} ${d.code}`)).toEqual([
    'src/pages/index.tscl:3:9 TS2353',
    'src/pages/index.tscl:4:27 TS2353',
  ])
})

test('#99: @type types a component\'s props: checked in the file and where it is used; errors in the type are located', () => {
  const root = project({
    'src/components/card.tscl': '@type User = { name: string; admin: boolean }\n@input user: User\n<p>{{ user.name }} {{ user.nmae }}</p>\n',
    'src/components/broken.tscl': '@type Id = Strng\n@input id: Id\n<p>{{ id }}</p>\n',
    'src/pages/index.tscl': "@import card from '../components/card.tscl'\n<card [user]=\"{ name: 'a', admin: true }\" />\n<card [user]=\"{ name: 'b' }\" />\n",
  })
  const result = check({ root, typescript })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line}:${d.column} ${d.code}`)).toEqual([
    'src/components/broken.tscl:1:12 TS2552', // Strng: cannot find name, did you mean String?
    'src/components/card.tscl:3:28 TS2339', // user.nmae
    'src/pages/index.tscl:3:8 TS2741', // admin missing
  ])
  expect(readFileSync(resolve(root, '.clarusjs/views.d.ts'), 'utf8')).toMatch(/declare namespace __cl_v\d+ \{\n  type User = \{ name: string; admin: boolean \}/)
})

test('#99: @interface and multi-line mapped, conditional and inferred @type types are checked like any TypeScript', () => {
  const root = project({
    'src/components/card.tscl': [
      '@interface Named { name: string }',
      '@interface User<Role = string> extends Named {',
      '  role: Role',
      '}',
      "@type Flags<K extends string> = { [P in K]: boolean }",
      '@type ElementOf<T> = T extends (infer U)[] ? U : never',
      "@input user: User<'admin' | 'guest'>",
      "@input flags: Flags<'dark'>",
      '@input first: ElementOf<number[]>',
      '<p>{{ user.name }} {{ user.role }} {{ flags.dark }} {{ first.toFixed() }} {{ flags.light }}</p>',
      '',
    ].join('\n'),
    'src/pages/index.tscl': "@import card from '../components/card.tscl'\n<card [user]=\"{ name: 'a', role: 'owner' }\" [flags]=\"{ dark: true }\" [first]=\"1\" />\n",
  })
  const result = check({ root, typescript })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
    'src/components/card.tscl:10 TS2339', // flags.light: not in the mapped type
    'src/pages/index.tscl:2 TS2322', // role 'owner' isn't 'admin' | 'guest'
  ])
})

test('#99: multi-line @input types and function-typed inputs are checked, at their lines', () => {
  const root = project({
    'src/components/picker.tscl': "@input options: {\n  size: 'sm' | 'lg'\n  label?: string\n} = { size: 'sm' }\n@input onPick: (id: string) => void\n<p>{{ options.size }} {{ options.colour }}</p>\n",
    'src/pages/index.tscl': "@import picker from '../components/picker.tscl'\n<picker [options]=\"{ size: 'xl' }\" [onPick]=\"(id: string) => id\" />\n<picker [onPick]=\"(id: number) => id\" />\n",
  })
  const result = check({ root, typescript })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
    'src/components/picker.tscl:6 TS2339', // options.colour
    'src/pages/index.tscl:2 TS2322', // size 'xl'
    'src/pages/index.tscl:3 TS2322', // onPick takes a string id
  ])
})

test('#217: inputs are deeply readonly: mutating one (or its arrays) is a type error; reading and copying are fine', () => {
  const root = project({
    'src/components/c.tscl': [
      '@input user: { name: string; tags: string[] }',
      '<script>',
      '  let copy = state({ ...user, tags: [...user.tags] })',
      "  function edit() { user.name = 'b'; user.tags.push('x'); copy.name = 'ok' }",
      '</script>',
      '<p>{{ user.name }} {{ copy.name }}</p>',
      '',
    ].join('\n'),
  })
  const result = check({ root, typescript })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line}:${d.column} ${d.code}`)).toEqual([
    'src/components/c.tscl:4:26 TS2540', // user.name: read-only property
    'src/components/c.tscl:4:48 TS2339', // push: not on a readonly array
  ])
})

test('#219: [(x)] needs @model x and a writable target; a child may assign its @model but not change inside it', () => {
  const root = project({
    'src/components/field.tscl': "@input label: string\n@model value: { text: string } = { text: '' }\n<script>\n  function clear() { value = { text: '' } }\n  function bad() { value.text = 'x' }\n</script>\n<p>{{ label }} {{ value.text }}</p>\n",
    'src/components/form.tscl': [
      '@import field from \'./field.tscl\'',
      '@input fixed: { name: { text: string } }',
      '<script>',
      "  let form = state({ name: { text: '' } })",
      '</script>',
      "<field [label]=\"'ok'\" [(value)]=\"form.name\" />",
      "<field [(label)]=\"form.name.text\" [value]=\"form.name\" />",
      "<field [label]=\"'ro'\" [(value)]=\"fixed.name\" />",
      '<input [(value)]="form.name.text">',
      '',
    ].join('\n'),
  })
  const result = check({ root, typescript })
  expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
    'src/components/field.tscl:5 TS2540', // value.text: inside a @model is read-only too
    'src/components/form.tscl:7 TS2322', // [(label)]: label isn't a @model of field
    'src/components/form.tscl:8 TS2540', // fixed is a read-only input
  ])
})
