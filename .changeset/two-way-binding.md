---
'clarusjs': patch
---

Two-way binding. `[(value)]="form.name"` on an `<input>`, `<textarea>` or `<select>` (and `[(checked)]` on a checkbox) shows a value and writes it back, copy-on-write (`form = { ...form, name: value }`), so a previous state is just the old value. On a component, `[(x)]` binds its `@model x` input, the one kind of input a component may write: the write goes to the parent island (a `cl:model` event), which updates its state and passes the value back in place; with no parent binding it, the component keeps the value. `clarusjs check` requires `@model x` for `[(x)]` and a writable target. A reactive `[value]`/`[checked]` binding now also sets the property, so a field shows it after someone has typed.
