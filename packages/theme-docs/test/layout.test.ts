// @clarusjs/theme-docs: the layout in a real build, used the way a site uses it (config, headings, slots).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createBuilder } from 'vite'
import { beforeAll, expect, test } from 'vitest'
import clarusjs from 'clarusjs/vite'
import { themeDocs } from '../src/vite.js'

let html = ''
let root = ''

beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), 'theme-docs-'))
  const w = (path: string, text: string) => { mkdirSync(resolve(root, path, '..'), { recursive: true }); writeFileSync(resolve(root, path), text) }
  mkdirSync(resolve(root, 'node_modules/@clarusjs'), { recursive: true })
  symlinkSync(resolve(import.meta.dirname, '..'), resolve(root, 'node_modules/@clarusjs/theme-docs'), 'dir')
  symlinkSync(resolve(import.meta.dirname, '../node_modules/clarusjs'), resolve(root, 'node_modules/clarusjs'), 'dir')
  w('src/config.ts', `export const config = {
  brand: { text: 'acme', accent: '.dev' },
  learn: { section: 'learn', progress: '/learn/progress' },
  sections: [{ key: 'learn', title: 'Learn', href: '/learn/one', groups: [{ title: 'First site', items: [{ title: 'One', href: '/learn/one' }, { title: 'Two', href: '/learn/two' }] }, { title: 'You', items: [{ title: 'Progress', href: '/learn/progress' }] }] }, { key: 'guide', title: 'Guide', href: '/guide/start', groups: [{ title: 'Basics', items: [{ title: 'Start', href: '/guide/start' }, { title: 'Next', href: '/guide/next' }] }] }],
  social: [{ label: 'GitHub', href: 'https://github.com/acme/x', icon: 'github' }],
  editLink: 'https://example.com/edit/:file',
  pages: [{ href: '/guide/start', title: 'Start', file: 'guide/start.tscl', updated: 1700000000 }, { href: '/guide/next', title: 'Next', file: 'guide/next.tscl' }],
  footer: 'Acme footer',
  search: true,
}
`)
  const page = (title: string, path: string, body: string) => `@import layout from '@clarusjs/theme-docs/layout.tscl'\n@import { config } from '../../config.ts'\n<layout [config]="config" [title]="'${title}'" [path]="'${path}'" [headings]="[{ id: 'one', text: 'One', level: 2 }, { id: 'two', text: 'Two', level: 3 }]">${body}</layout>\n`
  w('src/pages/guide/start.tscl', page('Start', '/guide/start', "<h1>Start</h1><h2 id=\"one\">One</h2>@slot('sidebar-top') {<p class=\"promo\">Promo</p>}@slot('footer') {<p>Custom footer</p>}"))
  w('src/pages/guide/next.tscl', page('Next', '/guide/next', '<h1>Next</h1>'))
  w('src/pages/index.tscl', "@import layout from '@clarusjs/theme-docs/layout.tscl'\n@import { config } from '../config.ts'\n<layout [config]=\"config\" [title]=\"'Home'\"><h1>Home</h1></layout>\n")
  const lesson = (path: string, body: string) => `@import lesson from '@clarusjs/theme-docs/lesson.tscl'\n@import { config } from '../../config.ts'\n<lesson [config]="config" [title]="'One'" [path]="'${path}'" [headings]="[{ id: 'read', text: 'Read', level: 2 }, { id: 'sub', text: 'Sub', level: 3 }, { id: 'write', text: 'Write', level: 2 }]">${body}</lesson>\n`
  w('src/pages/learn/one.tscl', '@import quiz from \'@clarusjs/theme-docs/quiz.tscl\'\n' + lesson('/learn/one', '<h1>One</h1><p>Intro</p><section class="step" aria-labelledby="read"><h2 id="read">Read</h2></section><section class="step" aria-labelledby="write"><h2 id="write">Write</h2><quiz [name]="\'quiz-0\'" [question]="\'Pick b\'" [options]="[\'a\', \'b\']" [answer]="1"><p>Because.</p></quiz></section>'))
  w('src/pages/learn/two.tscl', lesson('/learn/two', '<h1>Two</h1>'))
  w('src/pages/learn/progress.tscl', "@import layout from '@clarusjs/theme-docs/layout.tscl'\n@import learnProgress from '@clarusjs/theme-docs/learn-progress.tscl'\n@import { config } from '../../config.ts'\n<layout [config]=\"config\" [title]=\"'Progress'\" [path]=\"'/learn/progress'\"><h1>Progress</h1><learnProgress [config]=\"config\" /></layout>\n")
  await (await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: [themeDocs(), clarusjs()] })).buildApp()
  html = readFileSync(resolve(root, 'dist/client/guide/start/index.html'), 'utf8')
}, 120_000)

test('header: brand, section links with the current one marked, social icon links, ⋯ menu, ☰ for the drawer', () => {
  expect(html).toMatch(/<a class="brand" href="\/"><span>acme<span class="js">\.dev<\/span><\/span><\/a>/)
  expect(html).toContain('<a href="/guide/start" aria-current="true">Guide</a>')
  expect(html).toMatch(/<a href="https:\/\/github\.com\/acme\/x" aria-label="GitHub" title="GitHub">\s*<svg/)
  expect(html).toContain('popovertarget="more"')
  expect(html).toContain('<button type="button" class="menu-button" popovertarget="sidebar" aria-label="Open menu">')
})

test('sidebar: a popover nav with the current page, slots, and the header links for phones', () => {
  expect(html).toMatch(/<nav id="sidebar" class="sidebar" aria-label="Pages" popover>/)
  expect(html).toContain('<a href="/guide/start" aria-current="page">Start</a>')
  expect(html).toContain('<p class="promo">Promo</p>')
  expect(html).toMatch(/<div class="sidebar-links">.*GitHub/s)
})

test('content and "On this page": crumb, both forms of the table of contents, edit link, last updated, pager, footer slot', () => {
  expect(html).toContain('<p class="crumb">Guide › Basics</p>')
  expect(html).toMatch(/<aside class="toc" aria-label="On this page">.*<a href="#one">One<\/a>.*<li class="sub"><a href="#two">Two<\/a>/s)
  expect(html).toMatch(/<details class="toc-inline">\s*<summary>On this page<\/summary>/)
  expect(html).toContain('<a class="edit" href="https://example.com/edit/guide/start.tscl">')
  expect(html).toMatch(/<p class="updated">Last updated <time datetime="2023-11-14T22:13:20\.000Z">Nov 14, 2023<\/time><\/p>/)
  expect(html).toMatch(/<a class="next" href="\/guide\/next"><small>Next<\/small>Next<\/a>/)
  expect(html).toContain('<footer class="site-footer"><p>Custom footer</p></footer>')
})

test('a page without a date shows none', async () => {
  const next = readFileSync(resolve(root, 'dist/client/guide/next/index.html'), 'utf8')
  expect(next).not.toContain('class="updated"')
  expect(next).toContain('<a class="edit" href="https://example.com/edit/guide/next.tscl">')
})

test('search: a header button for the island, and the index written next to the pages, in small files', () => {
  expect(html).toMatch(/<span class="persist" data-cl-persist="search"><cl-island c="[^"]*search/)
  expect(html).toContain('<dialog class="search-dialog" aria-label="Search the docs"')
  const files = readdirSync(resolve(root, 'dist/client/search')).sort()
  expect(files).toContain('s-0.json')
  expect(files).toContain('t-st.json')
  const sections = JSON.parse(readFileSync(resolve(root, 'dist/client/search/s-0.json'), 'utf8'))
  expect(sections).toContainEqual({ u: '/guide/start#one', p: 'Start', h: 'One', t: '' })
  expect(JSON.stringify(sections)).not.toContain('Custom footer')
})

test('lesson layout: a focused header (leave, lesson n of N, one segment per step), the page, a fixed action bar', () => {
  const one = readFileSync(resolve(root, 'dist/client/learn/one/index.html'), 'utf8')
  expect(one).toContain('<title>One</title>')
  expect(one).toMatch(/<header class="lesson-header">\s*<a class="leave" href="\/learn\/progress" aria-label="Leave the lesson">/)
  expect(one).toContain('<p class="eyebrow">Learn · Lesson 1 of 2</p>') // the progress page isn't a lesson
  expect(one).toMatch(/<ol class="segments" aria-label="Steps">\s*<li><a href="#read">Read<\/a><\/li><li><a href="#write">Write<\/a><\/li>\s*<\/ol>/)
  expect(one).toContain('<main class="lesson" id="content" tabindex="-1"><h1>One</h1><p>Intro</p><section class="step" aria-labelledby="read">')
  // Hidden until its island attaches: without JavaScript the lesson is a plain page.
  expect(one).toMatch(/<div class="lesson-bar" role="region" aria-label="Lesson actions" hidden><cl-island c="[^"]*lesson-bar" [^>]*p="[^"]*next[^"]*\/learn\/two/)
  expect(one).not.toContain('class="sidebar"')
})

test('quiz: an island whose server HTML works without JavaScript (radio options, the answer in a <details>)', () => {
  const one = readFileSync(resolve(root, 'dist/client/learn/one/index.html'), 'utf8')
  expect(one).toContain('<div class="quiz" data-quiz="quiz-0">')
  expect(one).toContain('<p class="quiz-question" id="quiz-0-q">Pick b</p>')
  expect(one).toMatch(/<cl-island c="[^"]*quiz-choices"[^>]*><div class="quiz-choices">/)
  // Markers where the island's inputs are read (inputs are reactive since clarusjs #217).
  expect(one).toMatch(/<div class="quiz-options" role="radiogroup" aria-labelledby="quiz-0-q"( data-cl-a="\d+")?>.*<input type="radio" name="quiz-0" value="1"[^>]*> (<!--\[\d+-->)?b(<!--\]-->)?(<!--\[b\d+:-1--><!--\]-->)?<\/label>/s)
  expect(one).toMatch(/<details class="quiz-answer"[^>]*><summary>Show the answer<\/summary><p class="quiz-correct">Answer: b<\/p><p>Because\.<\/p><\/details>/)
})

test('progress: an XP chip (hidden until it knows the XP) in the lesson header and on Learn pages, and the progress page', () => {
  const one = readFileSync(resolve(root, 'dist/client/learn/one/index.html'), 'utf8')
  const progress = readFileSync(resolve(root, 'dist/client/learn/progress/index.html'), 'utf8')
  expect(one).toMatch(/<header class="lesson-header">.*<cl-island c="[^"]*learn-status"[^>]*><a class="xp-chip" href="\/learn\/progress" hidden/s)
  expect(progress).toMatch(/<header class="site-header">.*<cl-island c="[^"]*learn-status"/s)
  expect(html).not.toContain('learn-status') // a Guide page
  // The page lists the lessons (not itself); its numbers fill in in the browser.
  expect(progress).toMatch(/<cl-island c="[^"]*progress-board"[^>]*>.*<ol class="progress-lessons">.*href="\/learn\/one".*href="\/learn\/two".*<\/ol>/s)
  expect(progress).not.toMatch(/progress-lessons.*href="\/learn\/progress"/s)
})
