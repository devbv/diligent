---
name: backlog
description: "Manage a project backlog — record tasks, ideas, and work items to do later. Use this skill whenever the user mentions backlog, todo, tasks to track, wants to record something for later, says things like 'add to backlog', 'show backlog', 'mark done', 'what's pending', '나중에 해야 할 것', '기록해둬', '할일', or any request to track work items persistently. Also trigger when the user asks 'what should I work on next?' or wants to review pending work."
---

# Backlog Manager

Manage a persistent backlog of work items stored in `BACKLOG.md` at the project root. This file is human-readable markdown that works as both a Claude reference and a standalone document.

## Operations

### View backlog
Read `BACKLOG.md` and present the items. If the user asks what to work on next, show pending items. If the file doesn't exist yet, tell the user the backlog is empty.

### Add item
Append a new item to the `## Pending` section of `BACKLOG.md`. Each item is a checkbox line:

```
- [ ] **Title** — Description (added: YYYY-MM-DD)
```

If `BACKLOG.md` doesn't exist, create it with the template below first.

If the user doesn't provide an explicit description, write a brief one based on context. If the item came up naturally during a conversation (e.g., the user noticed something that needs fixing while working on something else), capture enough context so it makes sense when read later — someone reading the backlog weeks from now should understand what the item is about without needing the original conversation.

### Complete item
Move the item from `## Pending` to `## Done`, change `- [ ]` to `- [x]`, and append `(completed: YYYY-MM-DD)`.

### Remove item
Delete the line from `BACKLOG.md`. Only do this if the user explicitly asks to remove/delete an item (not complete it).

### Edit item
Update the title or description of an existing item in place.

## File Template

When creating `BACKLOG.md` for the first time:

```markdown
# Backlog

## Pending

## Done
```

## Guidelines

- Keep titles short and actionable (imperative form: "Add X", "Fix Y", "Investigate Z")
- Descriptions should give enough context to be useful weeks later
- When multiple items are added at once, add them all in a single edit
- Preserve the ordering within sections — newest items go at the bottom of each section
- Use today's date from the system context for timestamps
- The file should always be valid markdown that reads well in any viewer
- **After modifying BACKLOG.md**, also update the backlog summary in `plan/STATUS.md` (the "Backlog" section) to keep it in sync
