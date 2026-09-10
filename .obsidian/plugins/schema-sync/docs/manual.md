# CabCab Scheme DB — manual

Using the Schema Sync plugin from inside Obsidian. The agent-facing rules are in
[`agent-contract.md`](agent-contract.md); the design record is in
[`README.md`](../../../../README.md).

## The idea in one paragraph

Markdown is the database. A **schema** is a note listing an entity's fields. A
**record** is a note declaring `implements: <Schema>`. A **value list** is a
generated note holding every value one field has taken, which is what makes a
field behave like a dropdown. The plugin keeps those three consistent and
generates a Bases table per entity and one DBML ERD over the lot. Your job is to
write notes; its job is to keep them in shape.

It is deliberately not a DBMS. It optimises for editability and for relationships
between notes. Anything needing real constraints belongs in a real database.

## The dashboard

Ribbon icon, or the command **Open schema dashboard**. Three panels.

### 01 / Registry

Every schema in the vault. Per row: open the note, ⧉ duplicate, × delete.
**Clean orphaned config notes** lives here and in the command palette — it lists
value lists whose field or schema is gone, or that are stray copies, each with
the reason it was flagged. Nothing is preselected and files go to the trash.

### 02 / Definition

The field editor for the selected schema, and where most work happens.

Rows are **live by default** — no gate, changes apply as you make them, **Enter**
commits and **Escape** reverts a row you are part-way through. Drag ⠿ to reorder;
field order flows through to the schema note, the base columns and the ERD. A
blank field name is refused rather than saved.

**× is two-stage and non-destructive first.** On a bound field the first press
**unbinds** it — no confirmation, because nothing is written away and the bind
dropdown reverses it. The field stops reaching records, value lists, base views
and the ERD, and values already stored in records stay put as ordinary
properties. A second press on the now-unbound field removes it from the schema,
and that step asks, with "don't ask again this session".

**⤓** turns a field's value list into records — one record per row, named after
the value, with that field and the schema's identity field set to it. Existing
notes are skipped, so it is safe to press twice.

**☰** jumps to where the field's values live: its own value list, or for a
foreign key, the list belonging to the entity it points at.

### 03 / Relation

Records for the selected schema, templates included and badged. Per row: open,
⧉ duplicate, 🖼 Asset Renamer, × delete to trash. **+ New &lt;Schema&gt; record**
writes `_placeholder<N>.<Schema>.md` carrying every field, and is repeatable.

The layout reflows to the **pane** width rather than the window, so it behaves
when docked in a split.

## The two sync directions

The header has one button per direction. They are not symmetrical, and the
difference matters.

**↓ Sync schema system.** The schema is authoritative. Pushes it out to records,
value lists, base views and the ERD, and regenerates each Field Reference table
from `fields:`. Additive and safe — it never removes a record property. This also
runs automatically on change.

**↑ Pull from notes.** Bottom-to-top, and **destructive by design**. Each schema
note's Field Reference table *becomes* the field set: a row deleted there deletes
the field, a row added there adds it, blank cells resolve to the quiet defaults
(`string`, no default, not required, unbound, no relation). It confirms first and
lists exactly what will go. Values already in records are never touched — a
dropped field just becomes a free-form property. It pushes nothing outward, so
follow it with a sync.

## Editing a schema note by hand

Supported, and the plugin stays out of the way.

**A schema note open in any leaf is never rewritten** — not merely the active
one, but open anywhere, including a background tab. While it is the active view
changes are held entirely; only the dashboard refreshes. Move focus off it and
one sync applies your edits *outward*, leaving the note itself alone. It is
normalised once actually closed.

Both directions of the note are read. `fields:` frontmatter is authoritative.
The Field Reference table is an input too, **but only for adding**: a row with a
blank `Bound` cell is treated as hand-typed and adopted as an unbound field.
Rows carrying `yes` or `no` are the generator's own output and are ignored on the
way back in — which is what stops a deleted field resurrecting itself.

So **delete a field in `fields:`, or with × in 02 / Definition — never by
deleting its table row.**

## Base views are yours after the first sync

A `.base` is created when it is missing and then left alone. Reorder the columns,
rename the view, add a filter or a formula of your own — none of it is thrown
away, and a field you add to the schema shows up anyway because Bases reads a
record's properties itself.

The one thing sync still maintains is the `<field>Image` formula for each
attachment field, since only the schema knows which fields hold media. A formula
it creates gets a column; delete that column afterwards and it stays deleted.

To start over on a view, delete the `.base` file and sync — it will be rebuilt
from the schema.

## Where you can write in generated files

Generated files are rebuilt wholesale, so three places are protected:

| Where | Protected |
| --- | --- |
| Below `<!-- schema-sync:notes -->` in any generated file | Verbatim |
| The `Notes` column of a value-list row | Per row |
| Prose between the title and the Field Reference in a schema note | Verbatim |

**Record notes are never rewritten at all.** Only frontmatter keys are added,
never removed, and the body is untouched.

## Undeclared properties

Add a property to a record its schema does not declare and you are asked once:

| Choice | Effect |
| --- | --- |
| **Define and bind** | Adds the field to the schema *and* to every record of that schema, then opens the dashboard on it. |
| **Define, unbound** | Adds it as documentation only. Other records untouched, ready to bind later. |
| **Leave it alone** | Stays a property of that record alone, and is remembered so you are not asked again. |

Dismissing the dialog answers nothing — it asks again later. The type is inferred
from the value, including `attachment` when the value links to a non-markdown
file. Whatever you choose, the property itself is never removed or rewritten.

## Asset Renamer

Merged in, with its own ribbon icon, commands and file-menu entry — naming an
attachment is a separate job from keeping schemas in sync. Its dropdowns are
built from the record's **own schema's** value lists, so a note declaring no
schema is offered nothing. A note's schema is resolved from `implements:`, from a
value list's `configFor`, or from its path.

Commands: **Open asset renamer for active note**, **Configure asset renamer
sources**, **Bulk rename category dependencies**, **Bulk reload attachment names
from metadata**.

### Setting a field's Metadata Menu type

When Metadata Menu is installed, every value-list row in the renamer's filename
builder carries a **third column**: what that property is in Metadata Menu's
*Preset Fields*. It shows the current type, or *not in Metadata Menu*.

Pick a type and it is written straight into Metadata Menu's settings:

| Type | What this plugin writes |
| --- | --- |
| `Select`, `Multi`, `Cycle` | A `ValuesList` holding that field's own value list, so the dropdown offers exactly the values the schema knows about. |
| `Input`, `Number`, `Boolean`, `File`, `MultiFile`, `Formula` | The field, with the empty options those types start from. |
| `Date`, `DateTime`, `Time` | The field, with Metadata Menu's own date defaults (`YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, `HH:mm`). |
| everything else | The field with empty options, and a notice telling you to finish it in Metadata Menu. Those types carry settings this plugin cannot see, and half-filling them would break the field quietly. |

Choosing *not in Metadata Menu* deletes the preset, and asks first.

**This is the one place that may change a preset's type**, because you asked for
it by picking one. Nothing else does.

### What sync does on its own

A field is registered as a `Select` **once** — the first time its value list is
generated with anything in it. That is the whole of the automatic behaviour, and
it is remembered, so deleting the preset afterwards sticks: sync will not put
back something you removed on purpose.

After that, sync keeps the **options** of a preset it created in step with the
value list, so a value added to the table reaches the dropdown without you doing
anything. Only the options — never the type, and never a preset written by
anyone else. A preset is this plugin's if its id starts with `schema-sync-`.

**Configure asset renamer sources → Register missing fields** fills in any list
Metadata Menu does not have yet, leaving every existing preset alone. Use it for
lists that predate this, or after clearing something out.

### Shown plain, stored as a link

The menu offers `1` and `Nomadic clans` — not `[[1]]`, which turns a dropdown into
a list of brackets.

What lands in the record is the link. Sync casts a value-list field to `[[value]]`
whatever wrote it: the dropdown, the ⤓ button, or your own typing. That is what
makes the graph draw an edge between a record and the value it carries, because a
value list's rows either are notes already or become notes the moment ⤓ implements
them.

Nothing in Metadata Menu bridges those two forms, which is why the cast happens
here rather than there. It runs on the next sync, so a value typed by hand is
plain until then — the note you are editing is never rewritten under the cursor.

A value is a string **or a number**. YAML reads a bare `6` as a number, and a
value list of `1`–`6` is exactly that, so those count everywhere a value does. A
boolean or an object does not: neither is something to name a thing after.

The list itself stays plain — every reader strips the brackets — so a value cannot
gain a second layer however many times it goes round. An empty field stays empty:
`[[]]` is not a link.

Unbound fields, attachments and foreign keys are not cast. An attachment already
holds a link, and a foreign key has no list of its own.

### A value typed into a record joins its list

Put a value in a record's field and it appears in that field's value list about a
second later — no sync needed, and it reaches the Metadata Menu dropdown with it.
Only the list is written; the record is left exactly as you typed it.

Templates are the exception, as everywhere else: `_placeholder.<Schema>.md` is
never counted as data, so a value typed there does not join the list.

### A value added in Metadata Menu comes back

Typing a new value into a Metadata Menu dropdown adds it to *Metadata Menu's*
settings and to no note at all. Sync reads those values back before it rewrites a
list, so a value added that way lands in `data/config/<Schema>/<field>.md` like
any other — and is not lost when the options are pushed out again.

This only applies to a preset this plugin created. One you wrote yourself is read
from and written to by nobody.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Require unlock before editing a field | off | On, every row in 02 / Definition needs its ✎ pressed first. Slower, but harder to change a schema by accident. |
| Ask about undeclared record properties | on | The prompt described above. |
| Forget dismissed properties | — | Clears the "leave it alone" list so those properties are offered again. |
| Confirm before removing a field or deleting a record | on | Gates the second × on a field, and record deletion. Unbinding is never confirmed. |
| Fallback config folder | `assets/config` | Files here become dropdowns for notes declaring no schema. |
| config.base path | `assets/config/config.base` | One is always generated for `data/config` as well. |
| Metadata Menu mapping | off | Registers `Select` preset fields from the value lists. |

## Commands

**Sync schema system** · **Pull from notes** · **Validate schema notes** ·
**Open schema dashboard** · **Open schema ERD** · **Clean orphaned config
notes** · **Toggle schema safety for the active note** (pins a note as
never-rewritten even after closing) · **Generate config.base views**

## Working with the agent

Drop raw material into `data/raw/` — an export, a paste, a scribble. The agent
reads it, creates or extends the schema, writes the records, and moves the source
to `data/raw/done/`. It never writes value lists, base views or the ERD; those
appear the next time you open the vault and sync runs.

If it got a field's type wrong, fix it in 02 / Definition. If it invented a
schema that duplicates one you had, that is the one thing worth catching early —
merging two schemas after the fact means rewriting every record.
