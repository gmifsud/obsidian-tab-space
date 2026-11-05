# Working tabs — context

## Glossary

- **Tab** — one stored record (`SpaceNode.type === 'tab'`) tracking one leaf by `tabKey` (file path, or `viewType:leafId` for non-file views).
- **Pane** — an Obsidian tab container (`leaf.parent`, a `WorkspaceTabs`) in the main area. Has a runtime `id` (undocumented, same status as `leaf.id`).
- **Group** — a stored node that *claims one pane*. States: **live** (claims an existing pane via `homePaneId`), **dormant** (claims nothing; tab list intact, reopenable), **hidden** (live, pane `display:none`), **completed** (under `__completed__`).
- **Section** — a folder of groups representing a timeframe. May be **focused** (at most one).
- **Merge** — moving every live tab of group H into the pane of group G; H is removed and a **MergeReceipt** is kept for Undo.
- **Membership** — the rule deciding which group each live leaf belongs to, computed as a pure **plan** from a **WorkspaceSnapshot** (`src/membership.ts`), applied by `LeafSync`.

## Architecture notes

- Workspace is the source of truth for membership. Records are **moved** (`moveTabRecord`), never deleted and re-created, when a leaf appears under another live group.
- Opening a dormant group never merges implicitly. Merge is only via **Open in current pane (merge)** or dropping on a pane's centre zone.
- Focus: `focusedSectionId` on `TabSpacesData`; `isEffectivelyHidden` combines group hidden, section hidden, and focus.
