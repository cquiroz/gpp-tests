# Vendored ODB schema

`OdbSchema.graphql` is a snapshot of

<https://github.com/gemini-hlsw/lucuma-odb/blob/main/modules/schema/src/main/resources/lucuma/odb/graphql/OdbSchema.graphql>

taken on **2026-08-19**.

It exists so `npm test` can validate every document *and* every variable payload in
`lib/odb-operations.js` against the real ODB schema offline, in about 50 ms — which is what
catches a wrong enum value, a renamed field or a malformed input object before a stack is
booted. `lib/odb-operations.test.js` runs each operation through graphql-js with no resolvers,
so both validation and variable coercion happen for real.

## Refreshing it

```bash
curl -o schema/OdbSchema.graphql \
  https://raw.githubusercontent.com/gemini-hlsw/lucuma-odb/main/modules/schema/src/main/resources/lucuma/odb/graphql/OdbSchema.graphql
npm test
```

Update the date above when you do. A failing test after a refresh is the signal that the ODB
moved and the operations need adjusting — which is the point.

## The snapshot is not the deployed schema

The snapshot tracks `main`; the stack runs the `-dev` images, which also track `main` but at a
different moment. `tools/verify-operations.js` closes that gap by replaying every operation
against the live ODB right after boot (the regression workflow runs it as part of the
boot-stack action), so "the deployed ODB disagrees with us" fails loudly and specifically
rather than surfacing as a mysterious red journey later.

The SDL uses `@oneOf` without declaring the directive, so the tests build it with
`assumeValidSDL: true`. That only skips SDL-level validation of the schema document itself;
operation validation and variable coercion are unaffected.
