# CabCab Scheme DB

This vault is a markdown database. Schemas are notes, records are notes, and the
value lists that constrain them are notes. The **Schema Sync** plugin
(`.obsidian/plugins/schema-sync/`) keeps them consistent and generates the Bases
table views and the DBML ERD over the top.

The division of labour is deliberate: **the user records raw notes and data; the
agent normalises them into the schema.** Raw material lands in `data/raw/`. You
have full authority there — create a new schema, add or bind fields on an
existing one, file records — without asking first.

**Before touching `data/`, read the contract:**
[`.obsidian/plugins/schema-sync/docs/agent-contract.md`](.obsidian/plugins/schema-sync/docs/agent-contract.md)

The human-facing walkthrough of the dashboard is
[`docs/manual.md`](.obsidian/plugins/schema-sync/docs/manual.md); the system's
design record is [`README.md`](README.md).

## The five invariants

These are the rules that cause damage when broken. Everything else is in the
contract.

1. **Never hand-write a generated file.** `data/config/**`, `data/base/*.base`,
   `data/AssetDatabase.base.md`, and the `## Field Reference` table inside any
   `.schema.md`. Sync rebuilds them wholesale and your edit is gone.
2. **Prose in a generated file goes below `<!-- schema-sync:notes -->`.** That
   region, and the `Notes` column of a value-list row, are the only writable
   parts of a generated file.
3. **A schema's identity is its filename**, not its `schema:` property. The
   property is repaired to match on every sync.
4. **A field binds only when it declares a `type`.** No type means unbound: it
   reaches no record, no value list, no base column, no ERD. This is the safety
   catch for a half-formed idea — use it deliberately.
5. **Delete a field from `fields:` frontmatter**, never by deleting its Field
   Reference row. A deleted row is ignored on the way back in and the field
   resurrects itself on the next sync.

## Sync runs inside Obsidian

The plugin is the only thing that generates. When you write files with Obsidian
closed, nothing is normalised — no Field Reference table, no value lists, no
base views — until the vault is next opened. That is expected, not a failure.
Write the authored files correctly and let sync do its half.

## Version control

`data/` is ignored on `main` and `feature/*`, and tracked only on a
`data/<project>` branch. Never `git add -f` vault data onto a feature branch;
`.githooks/pre-push` will refuse the push anyway.
