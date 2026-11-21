# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What this is

clarusjs compiles `.tscl` components (templates with `{{ }}`, `@if`/`@for`, `(event)`, `[prop]`, plus an optional `<script>` with signals) into:

- a **server module**: `render(props) → string`, HTML with markers around reactive holes only;
- a **client module**, only for stateful components: `attach(root, props)`, which wires signals to the server's HTML without re-rendering it.

A Vite plugin picks the output per Vite environment and serves pages through a `fetch(Request) → Response` handler.
Design: [docs/architecture.md](docs/architecture.md). Status: early (`0.x`); the API can still change between minor versions.

## Commands

pnpm workspace (pnpm only; never npm or yarn).

```sh
pnpm install
pnpm test           # every package: unit tests + e2e against a real Vite dev server
pnpm typecheck      # tsc --noEmit in every package
pnpm dev            # serves examples/counter
pnpm docs:dev       # the docs site (packages/docs), built with clarusjs
pnpm docs:test      # builds the docs site and runs its Playwright tests (Chromium)
pnpm docs:check     # clarusjs check on the docs site: type errors at file.tscl:line:col
pnpm changeset      # describe a change to a published package (commit the generated file)
```

Run both `pnpm test` and `pnpm typecheck` before calling work done. Any change to a published package needs a changeset.
Releases are automated from `main` (see RELEASE.md): never run `npm publish` or `changeset publish` yourself.
`pnpm build` compiles each package to `dist/`; the published `exports` come from `publishConfig.exports`.

## Layout

| Path | What |
|---|---|
| `packages/clarusjs/` | the published `clarusjs` package; paths below are inside it |
| `src/compiler/` | `parse.ts` (source → syntax tree) → `ir.ts` (checks + IR) → `emit-server.ts` / `emit-client.ts`. `script.ts` does signal analysis and rewrites. `index.ts` exports `compile()` |
| `src/runtime/` | `server.ts` (escape, island), `signals.ts`, `dom.ts` (holes/text/on), `loader.ts` (finds islands, calls attach) |
| `src/server/handler.ts` | `createHandler(pages, { loaderUrl })` → `{ fetch, routes }`; full-document pages get doctype, island style and loader injected |
| `src/vite/` | `plugin.ts` (dev SSR, `vite build` = client build → server build → prerender, preview routing), `build.ts` (find components, prerender), `node.ts` (Node http ⇄ fetch) |
| `packages/content/` | `@clarusjs/content`, published: Markdown pages as a page source (`clarusjs({ sources: [markdown()] })`). Build-time only; its dependencies (markdown-it, yaml) never reach `clarusjs` or a browser bundle |
| `packages/theme-docs/` | `@clarusjs/theme-docs`, published: the docs layout as a theme (`layout.tscl`, `theme.css` tokens, theme toggle, copy, callout), shipped as source. Configured by a `config` prop, extended by slots |
| `packages/docs/` | the docs site, built with clarusjs; private. Its Playwright tests (`e2e/`) run against the built site and are the end-to-end proof of each framework feature |
| `examples/counter/` | the POC app (private workspace package, depends on `clarusjs: workspace:*`) |
| `.changeset/` | pending changesets and config |
| `test/` | mirrors `src/`; `test/fixtures/` (components and small apps built by the build tests); `test/helpers.ts` (`importCode`) |
| `docs/` | architecture (committed); `docs/superpowers/` holds local specs and plans (gitignored, never commit) |
| `.scratch/` | local notes and research (gitignored, never commit) |

## Rules

- **Compiler is pure.** `src/compiler/` takes strings and returns strings: no `fs`, no Vite imports.
- **ESTree only.** Treat acorn output as plain ESTree so the parser can be swapped (e.g. `oxc-parser`).
- **Server code never reaches the client.** Client modules must not import `render`, `clarusjs/runtime/server` or loaders.
- **Stateless components ship nothing.** No `<script>` → client compile is `export {}`.
- **HTML contract is fixed** (changing it is a design change; update `docs/architecture.md` §5 first):
  `<cl-island c="NAME" src="URL" p="PROPS" s="STATE" a="MODE">` (props and state via `runtime/serialize.ts`; `a` = idle/visible/interaction attach mode), `<!--[N-->…<!--]-->`, `data-cl-e="N"` (events), `data-cl-a="N"` (reactive attributes), `<!--[bN:K-->…<!--]-->` (`@if` blocks in islands; K = rendered branch), `<!--[fN-->` with `<!--[r-->` rows and `<!--[e-->` empty content (`@for` in islands), `<!--[cN-->` (child components re-rendered in islands), `data-cl-c="ID"` (top-level elements of a component with a scoped `<style>`), `<cl-head>…</cl-head>` (tags a page adds to its `<head>`; the server moves them there), and for client routes a shell with `<script type="application/json" id="cl-routes">` (with `data-title` = the title template, if set) plus `<path>/__data.json`, and with fragments on, `<path>/index.frag.html` with an optional `data-cl-swap` region and `data-cl-persist="key"` elements kept across swaps (see §5). Static parts carry no markers.
- **Removable wiring.** Everything wired inside an `@if` branch or `@for` row (effects, event handlers, nested blocks) is created inside a `scope()` from `runtime/signals.ts` and disposed when the branch or row is removed. Row wiring looks markers up only within its row (`Ctx` in `runtime/dom.ts`).
- **Escape everything dynamic.** Server holes go through `escape()`; attributes through `attr()` (escaped, URL-checked via `runtime/attrs.ts`, shared with the browser); island props through `island()`; the client writes text nodes and `setAttribute` only.
- **Generated names start with `__cl_`** so they never collide with author code.
- **Errors are located.** Compile errors are `ClarusError` with `file:line:col message`. Never let a raw acorn error escape.
- **Compiled output stays readable.** Exact-output tests in `test/compiler/emit-*.test.ts` pin it; update them deliberately.
- **Tests first.** Write the failing test, watch it fail, then implement. Bug fixes start with a reproducing test.
- **Size budgets are tests.** Browser runtime ≤ 5 KB gzip, a fixture site's JavaScript ≤ 6 KB gzip, published tarball ≤ 90 KB (unpacked ≤ 320 KB), dependencies exactly `acorn` (compiler) and `commander` (CLI), and no compiler or CLI code in browser assets (`test/build.test.ts`, `test/dist.test.ts`). Raising a budget or adding a dependency is a deliberate, explained change in its own PR.
- **Keep it small.** No new runtime dependencies beyond `acorn` (compiler) and `commander` (CLI); neither may reach a browser bundle. Deliberate shortcuts get a `ponytail:` comment naming the limit and the upgrade path.

## The docs site is the proving ground

Every framework feature is built because the docs site needs it: add the feature in `packages/clarusjs` with unit
tests, use it on the site, and cover it with a Playwright test in `packages/docs/e2e`. Nothing site-specific goes into
`packages/clarusjs`.

## Commits and PRs

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`…). No AI attribution footers or "generated with" lines in commits or PR descriptions.
