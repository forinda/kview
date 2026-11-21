---
'clarusjs': patch
---

Inputs are read-only and reactive, like `derived()`. In an island, each input is a read-only signal: holes, `@if`/`@for`, effects and `derived()` that read it update when it changes. A nested island whose parent island passes it new props gets them in place (its DOM and `state()` are kept) instead of being re-rendered. Assigning to an input is a compile error at its line (copy it to change it locally: `let local = state(count)`), and `clarusjs check` types inputs as deeply read-only, so changing anything inside one is a type error; a component's props accept read-only values.
