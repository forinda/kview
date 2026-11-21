// The published package is the built dist/, not src/. Build it once and check it works on its own.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, test } from 'vitest'

const pkgDir = resolve(import.meta.dirname, '..')
const dist = resolve(pkgDir, 'dist')

beforeAll(() => {
  execSync('pnpm build', { cwd: pkgDir, stdio: 'pipe' })
}, 120_000)

test('every published export points at a built file with types', () => {
  const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
  const exports = pkg.publishConfig.exports as Record<string, { types: string; default: string }>
  expect(Object.keys(exports).sort()).toEqual(Object.keys(pkg.exports).sort())
  for (const entry of Object.values(exports)) {
    expect(existsSync(`${pkgDir}/${entry.default}`)).toBe(true)
    expect(existsSync(`${pkgDir}/${entry.types}`)).toBe(true)
  }
})

test('built JS carries no comments (size); the declarations keep their docs (editor hovers)', () => {
  expect(readFileSync(`${dist}/server/head.js`, 'utf8')).not.toMatch(/\/\*\*|^\s*\/\/ /m)
  expect(readFileSync(`${dist}/server/head.d.ts`, 'utf8')).toContain('/** The site\'s public address')
  // The browser runtime keeps its comments: Vite reads /* @vite-ignore */ in apps that bundle it (and minifies it).
  for (const file of ['router', 'loader']) expect(readFileSync(`${dist}/runtime/${file}.js`, 'utf8')).toMatch(/import\([^\n]*\/\* @vite-ignore \*\/ src\)/)
})

test('built JS has no .ts import specifiers', () => {
  const plugin = readFileSync(`${dist}/vite/plugin.js`, 'utf8')
  const compiler = readFileSync(`${dist}/compiler/index.js`, 'utf8')
  expect(plugin + compiler).not.toMatch(/from ['"][^'"]+\.ts['"]/)
})

test('built compiler compiles a component', async () => {
  const { compile } = await import(`${dist}/compiler/index.js`)
  const out = compile('<script>let n = state(0)</script>\n<b (click)="n++">{{ n }}</b>', { file: 'c.tscl', target: 'client' })
  expect(out.code).toContain('export function attach')
})

test('built Vite plugin points at built runtime files that exist', async () => {
  const { default: clarusjs } = await import(`${dist}/vite/plugin.js`)
  const plugin = clarusjs()
  const aliases = plugin.config({}, { command: 'serve', mode: 'development' }).resolve.alias as { find: string | RegExp; replacement: string }[]
  // The runtime's own entries (the project's path aliases, like ~/, point into the project).
  for (const a of aliases.filter((x) => typeof x.find === 'string' && x.find.startsWith('clarusjs/'))) {
    expect(a.replacement.startsWith(dist)).toBe(true)
    expect(existsSync(a.replacement)).toBe(true)
  }
  const loader = plugin.resolveId.handler('/cl-loader.js')
  expect(loader).toBe(`${dist}/runtime/loader.js`)
  expect(existsSync(loader)).toBe(true)
  // #179: the built router gets its own copy of the built navigation guard.
  const guard = plugin.resolveId.handler('./navigate.js', `${dist}/runtime/router.js`) as string
  expect(guard).toBe(`${dist}/runtime/navigate.js?cl-copy=router`)
  expect(existsSync(guard.replace(/\?.*/, ''))).toBe(true)
  const entry = plugin.load.handler('\0virtual:clarusjs/server-entry') as string
  expect(entry).toContain(`${dist}/server/handler.js`)
})

test('every path in "files" exists, including README and LICENSE (npm shows the package README)', () => {
  const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
  expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'LICENSE', 'README.md']))
  for (const f of pkg.files as string[]) expect(existsSync(`${pkgDir}/${f}`), f).toBe(true)
})

test('the clarusjs command is built, with a shebang', () => {
  const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
  const bin = resolve(pkgDir, pkg.bin.clarusjs)
  expect(bin.startsWith(dist)).toBe(true)
  expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
})

// 90 / 320 KB: the TypeScript epic (#211: page sources in check, local types, reactive inputs, two-way binding) took
// the package past 80 / 290 KB. 80 / 290 KB before: the navigation epic (#169); 70 / 250 KB before that.
test('size budget: the published package stays small (tarball 90 KB, unpacked 320 KB)', () => {
  const [info] = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  expect(info.size, `tarball ${info.size} B`).toBeLessThanOrEqual(90 * 1024)
  expect(info.unpackedSize, `unpacked ${info.unpackedSize} B`).toBeLessThanOrEqual(320 * 1024)
})

test('#197: sideEffects lists only the browser scripts that start work when loaded (bundlers drop the rest when unused)', () => {
  const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
  const scripts = ['loader', 'router', 'fragments', 'navigation']
  expect(pkg.sideEffects).toEqual([...scripts.map((s) => `./src/runtime/${s}.ts`), ...scripts.map((s) => `./dist/runtime/${s}.js`)])
})

test('dependencies are exactly acorn (compiler) and commander (CLI): adding one is a deliberate change', () => {
  const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
  expect(Object.keys(pkg.dependencies).sort()).toEqual(['acorn', 'commander'])
})
