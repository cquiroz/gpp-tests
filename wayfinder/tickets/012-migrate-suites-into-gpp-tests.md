---
id: 012
title: "Migrate the three suites into gpp-tests"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [011]
---

## Question

Move the prototype out of odbattr into `gemini-hlsw/gpp-tests` as a production repo:
suites separated internally (browser / GraphQL / load, **load as the front door** per
ticket 020), shared `lib/` + parity catalog + reporting layer intact, `regression.yml`
and `performance.yml` adapted and **green** (performance still guard-gated until a
target exists — 016 for AWS, 026 for Heroku). Migrate **main and the `surge` branch**
in one move. Bring the docs each
suite needs (spec, relevant `research/`, `CONTEXT.md`); README points back to odbattr
as the archive. Decide the internal layout as part of this ticket. Resolution records:
first green run links, layout chosen, anything deliberately left behind.
