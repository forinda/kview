---
title: "Components inside islands"
group: "Interactivity"
order: 4
description: "Use other components inside an island: nested islands get new props in place, and inputs are read-only."
---
@import huePicker from '~/components/hue-picker.tscl'

# Components inside islands

<p class="lead">An island can use other components, including inside <code>@if</code> branches and <code>@for</code> rows.</p>

- A component **without** a script is re-rendered in the browser when the props or content it gets from the island change.
- A component **with** a script becomes its own island. When the island passes it new props, they reach it in place: its inputs update (and whatever reads them), while its own state stays.

Inputs belong to the parent, so a component reads them and never writes them: assigning to one is a compile error, and `clarusjs check` reports changing anything inside one. To change a value locally, copy it: `let local = state(count)`.

Try it: pin the swatch, then change the colour. The swatch is its own island; its hue comes from the picker, its pin is its own.

<huePicker />

The to-do list on the [home page](/) shows its count with a small component whose text comes from the island's state.
