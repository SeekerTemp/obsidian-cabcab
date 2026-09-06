# [[Operon Command Palette]]

This note is a quick reference for Operon commands available from Obsidian's Command Palette. Use it as a companion to [[Operon Basics Project]] when learning the plugin.

Some Operon commands are context-aware. The same command can behave differently depending on where you run it: selected text, an empty line, an inline task, a normal note, a file task, or a task view.

## Task Creation

### Create New Operon Task

Opens the full task creator. This is the safest starting point when you want Operon to guide you through creating a task.

Useful when:
- You do not want to write task syntax by hand.
- You want to create a task from anywhere, not only at the cursor.
- You want to choose fields such as status, priority, dates, parent task, estimate, recurrence, or links.

### Create or edit inline task

This command can do different things depending on your current cursor position, selected text, or task line. Use it when you want Operon to understand the note context for you.

Possible usages:
- Use it on selected text to turn that text into a new inline task.
- Use it on an existing Operon task to open that task in the Task Editor.
- Use it on a normal Markdown checkbox to upgrade it into an Operon task.
- Use it on a normal text line to convert that line into an Operon task.
- Use it on an empty line to create a new blank Operon task.

### Create file task

Creates a task that lives as its own note. The command can start from a normal context, selected text, or an existing inline task.

Possible usages:
- Use it on an inline task to turn that task into its own note.
- Use it with selected text to start the new file task from that text.
- Use it with no special cursor context to open the file task template picker.

## Task Editing And Conversion

### Edit or convert to file task

Works on the note you currently have open. It can either edit an existing file task or convert a normal note into one.

Possible usages:
- Use it in an existing Operon file task to open the Task Editor.
- Use it in a note that already has Operon task fields at the top to edit those fields.
- Use it in a normal note to convert that note into an Operon file task.

### Convert file task to inline task

Moves a file task back into inline task form. The insertion target can depend on where your cursor is and your default inline task settings.

Possible usages:
- Use it to choose a file task from Task Finder and convert it into an inline task.
- Use it with a clear cursor target to place the new inline task at that location.
- Use it without a good cursor target to send the inline task to your default inline task location.
- Use it when you are ready to move the old file task to trash after confirmation.

### Convert Tasks emoji line to inline task

Converts a task written in the Obsidian Tasks plugin emoji format into an Operon inline task.

Useful when:
- You are migrating old Tasks-plugin tasks.
- You have lines with due, scheduled, priority, or recurrence emoji metadata.
- You want scheduled, completed, and cancelled dates to use your configured workflow statuses.
- You want Operon fields instead of Tasks emoji syntax.

### Convert Selection to Operon Tasks

Converts selected Markdown list items into Operon inline tasks. It supports checkbox lines, Tasks emoji lines, bullet items, and numbered items.

When the selection contains an indented list, Operon preserves that outline as a real task tree. Each converted indented item is linked to the nearest converted or existing Operon task above it at a lower indentation level, so nested list items become child tasks instead of a flat list.

Useful when:
- You want to migrate a checklist or outline in one command.
- You want selected indentation to become Operon parent-child task links.
- You want supported Tasks emoji metadata to become Operon fields, including scheduled, completed, and cancelled dates using your configured workflow statuses.
- You want unsupported lines skipped instead of guessed.

## Finding And Moving Tasks

### Task Finder

Opens the task search and selection interface. Use it to quickly find tasks across the vault.

Useful when:
- You remember the task text but not the file.
- You want to inspect a task without browsing folders.
- You want to use task actions from a central search surface.

### Move an inline task here

Moves an existing inline task to the current cursor line. It uses Task Finder to choose the source task, then uses your current note position as the destination.

Possible usages:
- Use it on an empty line where you want the task to appear.
- Use Task Finder to choose the inline task you want to move.
- Use it to reorganize inline tasks without manually cutting and pasting task metadata.

## Task State And Time

### Toggle task completion

Toggles the task at the cursor between open and done. The exact update depends on whether Operon can fully recognize the task from the current view or only from the current line.

Possible usages:
- Use it on a normal Operon task to complete or reopen it through your workflow.
- Use it on a readable inline task line to update the checkbox and completion date directly.

### Start/stop time tracker

Starts or stops the timer for the task at the cursor. It changes behavior based on whether that task is already being tracked.

Possible usages:
- Use it on an untracked Operon task to start a timer.
- Use it on the active tracked task to stop the timer.
- Use it on another Operon task when you want to switch tracked work through the command flow.

## Views

### Operon Filter View

Opens the default Operon filter view. Use this for filtered task lists and saved filter sets.

### Operon Calendar

Opens the Calendar view. Use this for scheduled tasks, due markers, timed blocks, recurrence projections, and calendar planning.

### Operon Kanban

Opens the Kanban view. Use this for moving tasks through workflow statuses and swimlanes.

### Toggle Pinned Tasks dock

Shows or hides the floating pinned task dock.

### Open Time Session History panel

Opens the time session history panel. Use it to review and edit tracked work sessions.

### Open FlowTime panel

Opens the FlowTime panel for focused work sessions.

## Maintenance

### Rebuild full index

Runs a full Operon task index rebuild across the vault.

Use this when:
- Tasks are not appearing where expected.
- A file was edited outside Obsidian.
- You suspect the task index is stale.

### Show index stats

Shows a quick notice with task index counts, including total tasks, open tasks, due-today tasks, and overdue tasks.

### Open duplicate operonId manager

Opens the duplicate `operonId` manager. Use this when Operon detects multiple tasks sharing the same id.

### Update External Calendars

Refreshes configured external calendar sources.

Use this when:
- External calendar events are stale.
- You added or edited an external calendar source.
- You want to force a calendar sync before planning.
