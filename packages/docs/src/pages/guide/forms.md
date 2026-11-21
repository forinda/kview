---
title: "Forms"
group: "Interactivity"
order: 5
description: "Bind form fields two ways with [(value)] and @model, keep one state object, and reset or undo without cloning."
---
@import signupForm from '~/components/signup-form.tscl'

# Forms

<p class="lead">A form is one piece of state, written back as people type. <code>[(value)]</code> binds a field two ways; field components declare the input they may write with <code>@model</code>.</p>

## Native fields

`[(value)]` on an `<input>`, `<textarea>` or `<select>`, and `[(checked)]` on a checkbox, show a value and write it back:

```tscl
<script>
  let form = state({ name: '', plan: 'free', updates: false })
</script>
<input [(value)]="form.name">
<select [(value)]="form.plan"><option value="free">Free</option><option value="pro">Pro</option></select>
<input type="checkbox" [(checked)]="form.updates">
```

The target is a state variable or a property path of one. A write replaces the state, copy-on-write: typing in the first field runs `form = { ...form, name: value }`. Nothing is changed in place.

## Field components

Inputs are read-only: a component never writes what its parent gives it. The one exception is a `@model` input, which a parent binds with `[(…)]`:

```tscl
{{-- text-field.tscl --}}
@input label: string
@model value: string = ''
<label>{{ label }} <input [(value)]="value"></label>

{{-- the form --}}
<textField [label]="'Name'" [(value)]="form.name" />
```

When the field writes `value`, the write goes to the form, which updates its state, and the new value comes back to the field as an input, in place. The form stays the one owner of the data. A field with no parent binding it (an island on its own) keeps the value itself.

`clarusjs check` makes sure `[(x)]` names a `@model` of that component, and that the target can be written: binding to a read-only input is an error.

## Reset and undo

State is replaced, never changed in place, so a previous state is simply the old value. Nothing needs cloning:

```tscl
<script>
  let form = state({ name: '', email: '' })
  const initial = form                              // the starting value
  const changed = derived(() => form !== initial)
  let past = state([])

  function reset() { form = initial }
  function remember() { past = [...past, form] }    // before a change you may want to undo
  function undo() { form = past.at(-1) ?? initial; past = past.slice(0, -1) }
</script>
```

Take the starting value from the state (`const initial = form`), not from the object you passed to `state()`. In the browser, an island's state is restored from what the server rendered, so it's a copy.

Try it: fill in the form, then reset it.

<signupForm />
