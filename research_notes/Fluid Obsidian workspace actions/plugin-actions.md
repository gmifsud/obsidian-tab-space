# Plugin sidebar and workspace actions vs Obsidian layout

Source of truth is the plugin tree as it stands in this checkout (read November 2026). Nothing here was executed inside Obsidian. Line numbers refer to that checkout.

Obsidian objects the plugin actually touches, in its own words: a **pane** is `leaf.parent` (a `WorkspaceTabs`) in the main area; a **group** is a stored node that claims at most one pane via `homePaneId`; a **leaf** is one tab inside that pane. Direction names follow the plugin’s own comment on current Obsidian CSS: `direction: 'vertical'` is `.workspace-split.mod-vertical` (`flex-direction: row`, side by side, menu label “Split right”); `direction: 'horizontal'` is `.mod-horizontal` (`flex-direction: column`, stacked, menu label “Split down”). — [CONTEXT.md](D:/Repos/Obsidian/obsidian-tab-space/CONTEXT.md), [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css) lines 418–427, [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 30–35

The parallel model, stated once so later sections can point at it: groups, sections, hide, and focus live in `TabSpacesStore` (`data.json` via `saveData`). Obsidian remains the owner of the split tree. The plugin either (a) asks Obsidian to create or detach leaves, or (b) paints `display: none` / a stripe onto `.workspace-tabs` without editing flex values. Membership then rewrites the stored tree so it matches whatever panes `iterateAllLeaves` still reports. — [CONTEXT.md](D:/Repos/Obsidian/obsidian-tab-space/CONTEXT.md) lines 12–16, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 397–407, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 78–81

## What does each menu item, hover button, row click, and drop zone do, and which file/function implements it?

### Takeaway

Every sidebar gesture is built in `TabSpacesView` and delegated to `LeafSync` (leaves and panes) or `TabSpacesStore` (records only). Placement menus call `openGroup` / `openNewGroup`; the only explicit merges are the “Open in current pane (merge)” item and a centre drop. Hide and focus do not create or destroy splits.

### Cited Findings

#### Commands and settings that reach the workspace

- Ribbon icon “Open working tabs” and command `open-sidebar` call `activateView`: reuse `getLeavesOfType('working-tabs-view')`, otherwise `workspace.getLeftLeaf(false)`, `setViewState` to the plugin view, then `revealLeaf`. That occupies a left-dock leaf. Membership’s snapshot skips `leftSplit` and `rightSplit`, so this leaf never becomes a group. — [src/main.ts](D:/Repos/Obsidian/obsidian-tab-space/src/main.ts) lines 30–36 and 62–69, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 287–292
- Command `toggle-hide-tab-bar` flips `settings.hideTabHeaders`. The store listener toggles body class `working-tabs-hide-tab-headers`. CSS then sets `.mod-root .workspace-tab-header-container { display: none }`. The settings copy says the native “+” is gone and the group menu’s “New tab” is the replacement. — [src/main.ts](D:/Repos/Obsidian/obsidian-tab-space/src/main.ts) lines 38–55, [src/settings.ts](D:/Repos/Obsidian/obsidian-tab-space/src/settings.ts) lines 94–102, [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css) lines 539–548
- Other settings do not move leaves: confirm-before-complete, title overflow (sidebar class `working-tabs-wrap-titles`), colour coding (master switch inside `effectiveColor`). There is no settings control for `defaultOpenBehavior`. The stored default is `{ mode: 'tab' }`. — [src/types.ts](D:/Repos/Obsidian/obsidian-tab-space/src/types.ts) lines 153–158, [src/settings.ts](D:/Repos/Obsidian/obsidian-tab-space/src/settings.ts) lines 19–102, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 93–97

#### Hover buttons

Section row (`renderSection`):

- Crosshair “Focus section” / “Unfocus section” → `store.setFocusedSection(id | null)`. Writes `focusedSectionId` only. The store listener’s `refreshHidden()` is what paints panes. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 271–279, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 441–445, [src/main.ts](D:/Repos/Obsidian/obsidian-tab-space/src/main.ts) lines 20–25
- Eye “Hide all groups in this section” / “Unhide…” → `leafSync.toggleSectionHidden`. Flips the section’s `hidden` flag and calls `applyHiddenClass` on each child group. Child groups’ own `hidden` flags stay as they were. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 281–288, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 479–487
- Ellipsis “More” → `showSectionMenu`. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 290–292

Group row (`renderGroup`):

- If the group is not live (`homePaneId` with a leaf still in that pane): external-link “Open” opens a menu. “Split right” `{ mode: 'split', direction: 'vertical' }`, “Split down” `{ mode: 'split', direction: 'horizontal' }`, “New window” `{ mode: 'window' }`, “New tab” `{ mode: 'tab' }` each call `leafSync.openGroup(id, behavior)`. A separator item “Open in current pane (merge)” reads `getMostRecentLeaf().parent.id` (raw, not `getPaneId`) and calls `mergeGroupInto`. Completed groups are not live, so they get this Open button too. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 30–35 and 346–369, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 536–538
- If live: eye “Hide pane” / “Unhide pane” → `toggleGroupHidden` (flip that group’s `hidden`, then `applyHiddenClass`). — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 371–380, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 473–477
- Check-circle “Complete” → `requestComplete` (confirm modal unless `confirmBeforeComplete` is false) → `completeGroup`. Rotate-ccw “Restore” on a completed row → `store.restore` only. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 382–391 and 547–556, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 844–847, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 541–559
- Ellipsis → `showGroupMenu`. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 392–395

Tab row:

- Checkbox `change` → `handleToggleDone`: `store.toggleDone`, then if the flag is now set `closeLiveTabOnly` (detach matching leaves, keep the record), else `reopenTab`. If every sibling is `done` and the group is not already completed, `completeGroup` with no confirm. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 424–430 and 526–544, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 386–392
- “Close tab” (x) → `leafSync.closeTab`: detach the live leaf, `store.remove` the record, and `removeGroupIfEmpty` if that was the last record. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 437–440, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 966–980

`toggleDone`’s own comment says it is cosmetic and never closes a tab. The checkbox path is the one that detaches. The tab context menu’s “Mark done” / “Mark not done” calls only `store.toggleDone`, so it does not detach, reopen, or auto-complete. — [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 386–392, [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 934–938

#### Row clicks and keyboard

Clicks on data rows are delayed 250ms so a double-click can rename instead (`wireRowClick`). — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 663–676

- Section row click → `store.toggleCollapsed`, except while a search query is active. The chevron is not a separate handler. While any section is focused, other sections render collapsed and the focused one renders expanded; stored `collapsed` is not written for that. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 256–258 and 295–297
- Group row click, including a completed group → `leafSync.openGroup(id)` with no behavior override (uses `group.openBehavior`, else `settings.defaultOpenBehavior`). — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 397–397, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 571–600
- Tab row click → `focusTab`: if that `tabKey` is already open, `setActiveLeaf` + `revealLeaf`; otherwise `openGroup` on the parent first, then reveal. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 442–442, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 550–565
- Group chevron click → `toggleCollapsed` and `stopPropagation` (does not open). — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 329–332
- “New group” row → menu of Split right / Split down / New window only (`NEW_GROUP_BEHAVIOR_MENU` drops mode `'tab'`). Each item calls `openNewGroup`. The comment says mode `'tab'` would drop a blank tab into the active pane and join that pane’s group. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 37–40 and 454–465, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 510–518
- “Create a section” row → `store.addSection(nextDefaultTitle('section'))` then inline rename. No pane. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 471–483 and 741–744
- “Completed” header click → flips a view-local `completedCollapsed` and re-renders. Not stored. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 498–513
- `mousedown` on a data row → `setFocus` for the sidebar cursor (`is-focused`, `scrollIntoView`, and `treeEl.focus()`). This is not `setFocusedSection` and not `workspace.setActiveLeaf`. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 238–241 and 576–597
- Double-click on a title, F2, or Rename menu → `startRename` → `store.rename`. For a tab, also sets `titleOverridden` so later `syncTitle` will not overwrite it. Rename does not call any leaf API. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 681–708, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 302–321
- Tree `keydown`: arrows move the sidebar cursor or expand/collapse; Enter toggles a section, `openGroup`s a group, or `focusTab`s a tab; Delete/Backspace → `deleteNode`. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 607–660
- `workspace.on('active-leaf-change')` → `findTabForLeaf` → `revealNode`: expand collapsed ancestors (writes `collapsed`), uncollapse the Completed bucket locally, then highlight the row with `takeKeyboardFocus: false`. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 106–140, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 147–153

#### Context menus

Section menu (`showSectionMenu`):

- Focus / Unfocus → `setFocusedSection`. Same as the hover button. — lines 812–816
- “Open all” → for each non-live child group, `void openGroup(child.id)` with no override (concurrent, not awaited). — lines 817–824
- “Close all” → for each live child, `void closeGroup(child.id)` (concurrent). — lines 826–833
- Rename → inline rename. Edit description → `GroupDescriptionModal` → `setDescription`. Colour (only if `colorCoding`) → `showColorMenu` → `setColor` / `clearChildColors`. All record-only; accents repaint because `onChange` calls `refreshAccents`. — lines 836–860, [src/main.ts](D:/Repos/Obsidian/obsidian-tab-space/src/main.ts) lines 20–24
- “Delete section” → if the section has children, a Notice (“Move or complete this section's groups first.”) and return. If empty, `store.remove`. No leaf calls. — lines 863–870

Group menu (`showGroupMenu`), hidden entirely for the open/close items when `isCompleted`:

- “New tab” → `addBlankTab`. If the group is live, `createLeafInParent(homeLeaf.parent, 9999)` and `setViewState({ type: 'empty' })`. If it has records but is dormant, `openGroup` first. If it has no records and no pane, `createLeafForOpen` using the group’s open behavior, claim `homePaneId`, then an empty view. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 878–880, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 849–878
- “Close group” (live only) → `closeGroup`: `detach()` every leaf in `homePaneId`, then `setHomePane(id, undefined)`. Stored tabs stay. Comment equates this to Obsidian’s “Close all”. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 881–888, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 836–842
- “Undo last merge” if `receiptForTarget(groupId)` → `undoMerge`. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 890–897, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 692–747
- Rename, description, colour: same record-only paths as sections. — lines 901–926
- “Delete permanently” → `deleteNode`: a tab goes through `closeTab`; a group is `closeGroup` then `store.remove` (descendants included). — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 558–572 and 928–930, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 456–471

Tab menu (`showTabMenu`):

- Mark done / not done → `toggleDone` only (see checkbox contrast above). — lines 936–938
- “Move to new group” → `moveTabToNewGroup`: `addGroup` at root, `createLeafBySplit(anchor, 'vertical')`, `setHomePane`, `moveInto` the tab, then `relocateLiveLeaf` if that key is already open, else `openTabInLeaf` into the new leaf. Anchor is the source group’s pane, else the tab’s leaf, else `getMostRecentLeaf`. — lines 940–945, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 762–787
- “Move to: {group title}” for every other group, completed ones included → `moveTab(tab, groupId, children(group).length)`. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 946–951, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 749–760
- “Close tab” → `closeTab`. — line 955

Colour submenu (`showColorMenu`): one item per `COLOR_SLOTS`, “Use section colour” or “Automatic” (`setColor(undefined)`), “No colour” (`'none'`), and on a section “Reset group colours” (`clearChildColors`). DOM menu (`setUseNativeMenu(false)`) so swatches render. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 756–807

#### Drop zones

Sidebar rows are `draggable`. `dragstart` stores `draggedId`. Native workspace drags do not set `draggedId`, so these handlers ignore them. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 219–224 and 972–983

- On a row, vertical fraction decides the zone: middle 50% (0.25–0.75) is `into` when the target can parent the dragged node; otherwise `before` / `after` by the midpoint. Tabs may drop into a group or beside a sibling tab. Groups may drop into a section or beside a group/section. Sections only beside other root nodes. — lines 963–1015 and 1029–1055
- Tab drop → `leafSync.moveTab` (record via `moveInto`, then leaf work). Group or section drop → `store.moveInto` only. `moveInto` also clears a group’s explicit `color` when its parent changes to a section. — lines 1029–1055, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 490–533, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 749–760
- Drop on the tree background (`evt.target === treeEl`) → `moveInto(id, null, end)` for a group or section. Unparents it to root. — lines 1057–1070
- Drop on the Completed header → `requestComplete` for a group (same confirm path as the Complete button). — lines 1161–1174
- Main-workspace drop: delegated on `document.body` for `.mod-root .workspace-tabs` (side docks excluded). Only a dragged **group** is accepted. Zones are 25% edges; `y` is tested before `x`, so corners are top/bottom. Top/bottom → `openGroupAtDropTarget` with a horizontal split (`before` for top). Left/right → vertical split (`before` for left). Centre → `mergeGroupInto` when the target pane has an owning group. Same-pane drop returns immediately. — lines 1073–1150, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 790–834
- Centre highlight text `Merge into ${owner.title}` is looked up with raw `parent.id`, while the drop itself calls `getPaneId` (WeakMap-pinned). — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 1125–1133, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 22–36 and 802–811

#### What `openGroup` does on the click / Enter / Open-all path

1. If the group is effectively hidden, clear its `hidden` and its section’s `hidden`, then `applyHiddenClass`. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 575–580
2. If some section is focused and this group’s `parentId` is not that section, `setFocusedSection(null)`. — lines 582–585
3. If `homePaneId` still contains a leaf, `revealLeaf` and return. No new split. — lines 587–593
4. Otherwise take tabs that have `viewState` or `filePath`, remember a menu override via `setOpenBehavior`, create a leaf with `createLeafForOpen`, `setHomePane`, and while `openingGroups` contains the id (reconcile will not mirror that group) open the first tab in that leaf and the rest with `createLeafInParent(first.parent, 9999)`. — lines 596–618 and [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 172–177

`openNewGroup` does not insert a group record. It creates one empty leaf and activates it. The next reconcile’s unclaimed-pane step inserts “Group N”. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 510–518, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 296–316

### Inferences

- The sidebar is a second catalog of the same leaves: row click and Enter go through `openGroup`, which reveals, unhides, or manufactures a pane, while section clicks, rename, description, colour, and most group drags only edit `SpaceNode`s.
- Completed groups are excluded from `plan()` (`parentId !== COMPLETED_PARENT_ID`) but their rows still call `openGroup`, which will `setHomePane` and create leaves. The following reconcile sees an unclaimed pane and emits `newGroup` + `addTab`, leaving the completed copy in place. That is a second group spawned by a sidebar click the planner is written to ignore. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 97 and 296–316, [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) line 397
- README says opening “into an already-occupied pane merges the two groups.” `CONTEXT.md` and `createLeafForOpen` say mode `'tab'` never merges. The code matches the context file, not that README sentence. — [README.md](D:/Repos/Obsidian/obsidian-tab-space/README.md) line 46, [CONTEXT.md](D:/Repos/Obsidian/obsidian-tab-space/CONTEXT.md) line 15, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 567–570 and 621–632

### Gaps

- Clicks were not run in Obsidian, so it is unverified whether a sidebar click makes `getMostRecentLeaf()` return the working-tabs leaf before `openGroup` reads it. The code does not filter out `leftSplit` / the plugin view at that call site; the snapshot does filter them out.
- No check of Obsidian’s current `createLeafBySplit` / `getLeaf` type declarations in `node_modules`. Direction meaning is taken from this plugin’s CSS comment and menu labels.

## Which actions create splits (direction vertical vs horizontal), move leaves, or only change stored records?

### Takeaway

Side-by-side splits are `createLeafBySplit(..., 'vertical')`; stacked splits are `'horizontal'`. Mode `'tab'` is the exception: it appends a leaf in an unowned pane, and when that pane is already claimed it always splits vertically. In-place moves use undocumented `removeChild` / `insertChild`. Hide, focus, rename, colour, section membership, and restore do not create splits.

### Cited Findings

#### Creates a new split or window

- “Split right” and any `createLeafFor({ mode: 'split', direction: 'vertical' })`: `createLeafBySplit(getMostRecentLeaf(), 'vertical')`, or `getLeaf('split', 'vertical')` if there is no recent leaf. `before` is omitted, so the new leaf is after the anchor (right). — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 489–507
- “Split down”: the same with `'horizontal'` (below the anchor). — same function, [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 30–32
- “New window”: `workspace.getLeaf('window')`. A popout leaf is included in the next snapshot unless its root is the left or right split, and an unclaimed pane becomes a new group. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 502–503 and 287–305, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 296–304
- Workspace edge drop: `createLeafBySplit(targetLeaf, direction, before)` on the pane under the pointer, not on the most recent leaf. Top/left pass `before === true`. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 814–820
- Mode `'tab'` when the most recent leaf’s pane is owned by some other group (or there is no pane id): `createLeafBySplit(active, 'vertical')`. Hard-coded vertical. No `before` argument. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 621–630
- `moveTabToNewGroup` and `undoMerge` always `createLeafBySplit(anchorOrTarget, 'vertical')`. Undo does not restore the pre-merge split geometry; it splits the target pane to the right and reopens surviving tab records there. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 733–742 and 774–776
- After the first leaf exists, extra tabs in that group are `createLeafInParent(parent, 9999)` (append in the same pane, no new split): `openGroup`, `openGroupAtDropTarget`, `addBlankTab`, `reopenTab`, `mergeGroupInto`. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 610–613, 657–659, 826–828, 867–868, 919–921
- Mode `'tab'` when the active pane is **not** owned: `createLeafInParent(active.parent, 9999)` and then `setHomePane`, so the group claims that existing pane instead of splitting. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 623–627 and 604–605
- `openGroupAtDropTarget` on an edge, for a group that is already live, `closeGroup`s first (detach every leaf, clear `homePaneId`) and then splits and reopens from stored `viewState` / `openFile`. It does not move the existing leaves. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 814–829 and 836–842
- No call site uses a public move-leaf API. The only relocation of an already-open leaf is `relocateLiveLeaf`. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 924–960

#### Moves or detaches existing leaves

- `relocateLiveLeaf` (from `moveTab` when the target group is live and the key is already open, and from `moveTabToNewGroup`): `parent.removeChild`, `target.insertChild(index)`, optional `selectTabIndex`, optional `workspace.requestResize`. Index comes from `countLiveSiblingsBefore` (stored order among siblings that are open in the target pane). If those methods are missing it returns without moving. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 749–760 and 924–960
- `moveTab` into a group with no live pane updates the record and returns. The leaf stays where it was. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 749–755
- `closeGroup` / the first half of an edge-drop of a live group / `completeGroup`: `detach()` each leaf in the pane. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 836–847
- `closeLiveTabOnly` / `closeTab`: `detach()` leaves in the group’s pane whose identity key matches. `closeTab` also deletes the record. — lines 885–893 and 966–970
- `mergeGroupInto`: if the source pane is live, `closeGroup` (detach all of its leaves), `moveTabRecord` each restorable tab onto the owner, `createLeafInParent` + `openTabInLeaf` in the target, `store.remove(sourceId)`, push a session receipt (max 5) and a Notice with an Undo button. If the target pane has no owning group, return with no leaf changes. — lines 639–674
- `focusTab` and the live branch of `openGroup`: `revealLeaf` / `setActiveLeaf` only. — lines 554–565 and 587–592
- Opening a tab prefers `leaf.setViewState` from the stored state, and falls back to `leaf.openFile` for a file path. — lines 521–533

#### Stored records only (no new split, no detach)

- Rename, description, colour, collapse, search, Completed header collapse, section create, section delete (empty only), `store.restore`, `moveInto` of a group or section (including drag to root or into a section), `setOpenBehavior`, `setFocusedSection`, `toggleHidden` (the class toggle is separate and does not change the split tree). — [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 230–243, 302–409, 441–454, 490–559, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 408–418
- `store.complete` clears `homePaneId` and reparents under `__completed__`. Callers are expected to detach first. `completeGroup` does. A merge’s `removeGroup` does not call `complete`. — [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 536–548
- Sidebar reorder of tabs in a live group is not record-only: it goes through `moveTab` → `relocateLiveLeaf`, so the Obsidian tab strip is rewritten to the stored index. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 1029–1042

#### Anchor used for “where”

- Menu splits, `openNewGroup`, mode `'tab'`, and “Open in current pane (merge)” anchor on `getMostRecentLeaf()` (merge then reads raw `parent.id`). Edge/centre drops anchor on the pane under the cursor via `findLeafForPaneEl`. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 495–500 and 622–632, [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 359–366 and 1142–1149
- `getPaneId` pins the first id seen for a parent object (`parent.id`, or `pane:N` if missing) because “`leaf.parent.id` is undocumented and can churn across splits/drags.” `homePaneId` stores that pinned id. The merge menu and the centre-drop label do not go through `getPaneId`. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 22–36

### Inferences

- Two placement policies sit side by side. “New group” refuses mode `'tab'` so it will not join the active pane. “Open” still offers “New tab”, and that path joins an unowned pane or splits an owned one vertically. After any Open-menu choice, `setOpenBehavior` makes that choice the row-click default for that group. Auto-created groups copy `{ mode: 'tab' }` at birth, and the settings screen never changes the global default. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 37–40, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 246–259 and 403–408, [src/types.ts](D:/Repos/Obsidian/obsidian-tab-space/src/types.ts) lines 153–155
- Dragging a live group onto a pane edge is “close the old pane, open a new split,” not an Obsidian leaf move. Dragging a tab onto a dormant group updates the catalog and leaves the leaf in the old pane, which the next membership pass can treat as a different tab (see the next section).

### Gaps

- `createLeafBySplit`’s default `before` (after the anchor) is inferred from the menu labels “Split right” / “Split down” and from the plugin passing `before` only for top/left drops. Obsidian’s implementation was not opened.
- Whether `detach()` of the last leaf also removes the parent split is Obsidian’s behavior; this plugin only detaches and clears `homePaneId`.

## Where does membership reconcile rewrite groups in response to native Obsidian drags, closes, and new panes?

### Takeaway

`LeafSync` listens to `layout-change` (and a 3s poll) and applies a pure `plan()` from `membership.ts`. Native tab drags between two panes that are still claimed move records in place. A brand-new pane becomes a new group, parented under the focused section if there is one. A pane that disappears releases its group; the group is deleted only when nothing but blank tabs remains. A full native move that destroys the source pane does not take the tested merge path, because the live snapshot never contains a pane with zero leaves.

### Cited Findings

#### When it runs, and what it refuses to see

- `start()` reconciles on `layout-ready`, on every `layout-change`, and every 3000ms in `'poll'` mode. Vault `rename` of a `TFile` calls `remapTabPath` directly (path, `tabKey`, title unless overridden, and `viewState.state.file`). — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 192–216 and [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 344–363
- Overlapping calls collapse to one follow-up pass. A queued `'full'` is not downgraded by a poll. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 218–250
- `snapshot()` walks `iterateAllLeaves`, skips `leftSplit`, `rightSplit`, and `VIEW_TYPE_WORKING_TABS`, and groups leaves by `getPaneId`. Poll mode omits `viewState` unless the last full view-state sync was at least 30s ago. Panes with no leaves are absent: the map is filled only from leaves. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 266–306
- `openingGroups` (set for the duration of `openGroup`, `mergeGroupInto`, `undoMerge`, `moveTabToNewGroup`) is `suppressedGroupIds`. Those groups are skipped by the mirror step so a half-built pane is not pruned mid-open. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 607–616, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 172–177
- Completed groups are omitted from `groups`, so their panes are not claimed by them. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) line 97

#### Plan steps and the store writes they become

`applyPlan` maps each entry onto the store. `'merged'` does not move tabs; it only records a receipt and shows the Undo notice. `'removeGroup'` is `store.remove`, which also deletes every node still parented under that id. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 308–364, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 456–471

1. **Live sync.** For every leaf whose key matches a stored tab: `syncTitle` (no-op if `titleOverridden` or the title already matches) and, in full mode, `syncViewState` (no-op if JSON is unchanged). Oversized view-state strings (> 8192 chars) are stripped before they are stored; the comment names Terminus `scrollback` as the reason. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 117–127, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 45–91, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 314–341
2. **Claim / release.** A group whose `homePaneId` is still in the snapshot emits `claimPane` (`setHomePane`). If that pane id is gone: `releasePane` (clear `homePaneId`), `pruneTab` for every not-done blank tab (`no filePath` and view type missing or `'empty'`), and `removeGroup` when zero tabs survive that prune. File tabs and done tabs keep the group as a dormant list. This is the native-close path (close last tab, close split, close all). — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 53–58 and 129–149, [README.md](D:/Repos/Obsidian/obsidian-tab-space/README.md) line 50
3. **Reattach.** For an unclaimed pane, the first dormant group whose every not-done keyed tab is present in that pane gets `claimPane`. Partial overlap does not reattach; the pane falls through to step 6 and the dormant list is left alone. A test covers pane-id change when the key set still matches exactly: `releasePane` the old id and `claimPane` the new one, no `newGroup`. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 152–169, [src/membership.test.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.test.ts) lines 90–118 and 287–304
4. **Mirror, claimed panes only, two passes.** A leaf key with no stored tab → `addTab`. A key whose stored parent is a different **live** group → `moveTabRecord` (same node id; the comment and the test call this out as not destroy/recreate) and the source is noted in `movedOut`. A key whose parent is dormant or missing → `addTab` on the live group and the dormant list is not edited. Second pass: not-done tabs still parented here whose key is absent from the pane → `pruneTab`. Done tabs are not pruned. Then `setOrder` follows pane order for keys still in the group, with any not-shown siblings (done tabs) after them. `setOrder` no-ops when the number already matches. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 171–267, [src/membership.test.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.test.ts) lines 120–143 and 238–275, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 366–376 and 424–435
5. **Merge detection.** If a group that was claimed (or still has `homePaneId` on the node) has a `movedOut` bucket aimed at a single target, and no not-done tab remains parented to it: `releasePane`, `merged` (receipt + notice only), `removeGroup`. The unit test feeds `pane('pH', [])` plus the destination pane. Production `snapshot()` cannot emit a leaf-less pane. So this step runs only when the source pane is still in the snapshot (it still has at least one leaf) while every not-done tab record was `moveTabRecord`’d to one other live group. `removeGroup` then cascades: done tab records still parented to the source are deleted with the group. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 270–294, [src/membership.test.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.test.ts) lines 145–164, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 287–306 and 347–362, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 456–471
6. **New pane.** Any pane still unclaimed → `newGroup` with `parentId: focusedSectionId` (null if nothing is focused) and `title` from `nextDefaultTitle('group')` (“Group N”, counted from existing group nodes), then `addTab` per leaf under a provisional id `__new__:${paneId}` which `applyPlan` rewrites to the real id. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 49–51 and 296–316, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 341–346, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 220–227, [src/membership.test.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.test.ts) lines 211–216

#### Native gestures, as those steps compose

- **Drag one tab from live pane A into live pane B, A still has other leaves.** Step 4 emits one `moveTabRecord`. No `merged`, no `removeGroup`. Done siblings in A stay. Test name: “moves a tab record between live groups without destroy/recreate.” — [src/membership.test.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.test.ts) lines 120–143
- **Drag a tab out into a brand-new split (new pane id, source pane still has other leaves).** The new pane is unclaimed during step 4, so the source side `pruneTab`s the key. Step 6 `addTab`s a new record in a new group. `titleOverridden` and `done` are not copied; `addTab` sets title, key, path, viewState, order. The new group’s parent is the focused section id or root, not the source group’s parent. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 243–249 and 296–315, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 280–298
- **Drag every leaf out of a pane so the pane disappears.** Step 2 releases the source and keeps it if any non-blank tab remains. Step 4 sees the source as not live (`claimByGroup` already deleted), so it `addTab`s duplicates on the destination instead of `moveTabRecord`, and `movedOut` stays empty, so step 5 does not emit `merged`. The dormant source keeps its original tab nodes. `tabByKey` is a `Map` that last-write-wins on duplicate keys. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 91–95, 129–149, 199–233, 270–274
- **Same file open in a live pane and also listed on a dormant group.** The dormant list is not pruned or moved; the live pane gets an `addTab` for that key. Test: “does not mutate dormant tab lists when another pane shows the same keys.” — [src/membership.test.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.test.ts) lines 260–275
- **Native close of a pane.** Release, prune blanks, delete the group only if that leaves zero children. Matches the README line that closing does not delete a group that still has a tab list. — [README.md](D:/Repos/Obsidian/obsidian-tab-space/README.md) line 50, [src/membership.test.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.test.ts) lines 166–183
- **Any new main-area pane** (user split, `openNewGroup`’s empty leaf, a popout leaf that is iterated): step 6 creates the group. While a section is focused, that group is filed under it, which is also what keeps `effectivelyHidden` from hiding the pane the user just opened. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 296–304, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 60–69
- **Sidebar tab drag onto a dormant group** does not itself call `plan`. It `moveInto`s the record and leaves the leaf in the old pane. The next `layout-change` or poll then sees the key still in the live source pane and the record parented to a non-live group, which is the step-4 `addTab` branch: a second record in the live group, dormant record retained. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 749–755, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 223–232
- Reconcile does not hide, unhide, or build splits. After `applyPlan`, `doReconcile` calls `applyHiddenClass` and `applyAccent` for every group that still has a leaf in `homePaneId`. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 279–284

`CONTEXT.md` says merge happens only from the menu item or a centre drop. Step 5 is an additional merge, with the same receipt UI, when a native drag matches the planner’s conditions. The empty-pane fixture in the test is not a shape `snapshot()` produces. — [CONTEXT.md](D:/Repos/Obsidian/obsidian-tab-space/CONTEXT.md) line 15, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 270–294, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 287–306

### Inferences

- The stored tree is a mirror with its own identity rules: one group per pinned pane id, tabs moved by key between live groups, new groups invented for panes the plugin did not create, and dormant lists preserved even when the same file is open elsewhere. Native split/drag/close are not recorded as layout operations; they show up only as claim, move, prune, add, or delete of `SpaceNode`s.
- Filing new panes under `focusedSectionId` means “focus” changes where Obsidian’s own new splits land in the catalog, not only which panes are CSS-hidden.

### Gaps

- Not observed in a running app: whether Obsidian leaves an empty leaf behind when the last real tab is dragged out (that would keep the source pane in the snapshot and could fire step 5), or destroys the pane (step 2 + duplicate `addTab`).
- `iterateAllLeaves` coverage of popout windows was not confirmed against the Obsidian version installed here. The code will group any iterated leaf whose root is not the left or right split.

## Which CSS rules in styles.css touch .workspace-split or .workspace-tabs, and how can they change layout?

### Takeaway

Four workspace rules change main-area layout or hit-testing: hide a pane with `display: none`, collapse a split whose every pane is hidden, hide the main-area tab header row, and set `position: relative` on a pane while it is colour-striped or showing a drop overlay. The stripe and drop overlays are `pointer-events: none` and do not set flex.

### Cited Findings

Rules that select Obsidian workspace classes (all in [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css)):

- `.workspace-tabs.working-tabs-accented { position: relative }` (line 386) and `::before` a 3px full-height stripe, `position: absolute`, `pointer-events: none`, `z-index: 1` (lines 390–401). Class and `--working-tabs-accent` are set by `applyAccent` on the `.workspace-tabs` that contains the group’s leaf. Cleared when `effectiveColor` returns undefined (colour coding off, `'none'`, or no slot). The comment says a border was rejected because it would shift layout, and `position: relative` is forced so the stripe’s containing block is the pane. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 421–454, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 93–97
- `body:not(.is-phone) .workspace-split.mod-root .workspace-tabs.working-tabs-hidden-pane { display: none }` (lines 418–420). Class is toggled by `applyHiddenClass` from `isEffectivelyHidden`. On `.is-phone` the rule does not match, so the class has no layout effect there. Side docks are outside `.mod-root`, so they are not hidden by this rule. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 408–418, [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css) lines 418–420
- `body:not(.is-phone) .workspace-split.mod-root .workspace-split:not(:has(.workspace-tabs:not(.working-tabs-hidden-pane))):has(.workspace-tabs.working-tabs-hidden-pane) { display: none }` (lines 428–430). A nested split is removed from layout only when it contains at least one hidden pane and no visible `.workspace-tabs`. The comment records that an earlier version forced `display: flex` on nested splits and that this broke Obsidian’s stacked-split chain (`.mod-horizontal > * { height: 0; flex: 1 0 0 }`), collapsing stacked panes on load. The current rule does not set `flex`, `flex-direction`, `width`, or `height`. — [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css) lines 364–430
- Drop classes on `.workspace-tabs` (`working-tabs-pane-drop-top|bottom|left|right|center`): `position: relative` only while the class is present (lines 437–443). `::after` is an absolutely positioned tint, 25% of the pane on an edge or the inner 10% inset for centre, `pointer-events: none`, `z-index: var(--layer-popover)` (lines 445–494). Centre with `data-working-tabs-merge-target` replaces the overlay content with that attribute via `content: attr(...)`, `display: flex` on the pseudo-element only (lines 496–506). Added and removed in the body `dragover` / `drop` / `dragleave` handlers. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 1112–1146
- `body.working-tabs-hide-tab-headers .mod-root .workspace-tab-header-container { display: none }` (lines 546–548). This is the tab header row inside each `.workspace-tabs`, not `.workspace-tabs` itself. Scoped to `.mod-root` so the sidebar’s own header row is left alone. The comment says an earlier attempt to hide more broadly and then undo the sidebar shifted that row by a couple of pixels. Hiding the header removes its height from the pane, so the leaf content takes that space. It also removes the native tab strip’s drag, close, and “+” targets in the main workspace; the sidebar’s “New tab” / “Close tab” / `relocateLiveLeaf` are the replacements the settings text points at. — [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css) lines 539–548, [src/main.ts](D:/Repos/Obsidian/obsidian-tab-space/src/main.ts) lines 47–55, [src/types.ts](D:/Repos/Obsidian/obsidian-tab-space/src/types.ts) lines 135–137

No other `styles.css` rule selects `.workspace-split` or `.workspace-tabs`. Sidebar rules (`.working-tabs-row`, drop markers on rows, and so on) do not. — [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css) lines 386–548

`applyHiddenClass` / `applyAccent` look up `leaf.view.containerEl.closest('.workspace-tabs')`. They do not walk parent splits in JavaScript. The `:has()` rule is what collapses an all-hidden split. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 397–418

### Inferences

- Hide and focus change the visible layout by taking panes out of flex (`display: none`), so siblings grow. They do not write Obsidian split ratios. Showing the pane again drops the class and leaves whatever flex Obsidian had stored. That is a visibility layer on top of the split tree, which is why a hidden pane is still a live group (`isLive` / snapshot still see its leaves).
- `position: relative` on `.workspace-tabs` (accent, and briefly during a sidebar drag) changes the containing block for any absolute-positioned descendants Obsidian puts in that element. The plugin’s own stripe and overlay are written not to take pointer events so the drop zones still hit the pane.

### Gaps

- Whether popout windows receive this `styles.css` was not checked. Selectors that apply there would hide panes and tab headers in the popout the same way, because they key off `.mod-root` and a body class, not the main window’s document specifically.
- No measurement of how much vertical space `.workspace-tab-header-container` occupies, or of whether `position: relative` on `.workspace-tabs` clips Obsidian’s own tab-drag ghosts.

## What recent pain is visible in the code: open mode 'tab' always splitting vertically when a pane is owned, centre-drop merge, focus hiding panes outside a section, reconcile notifying the sidebar?

### Takeaway

All four are current behavior, with comments that describe earlier failures (split flex corruption, per-tab sidebar renders, terminal scrollback forcing a rewrite every pass). Mode `'tab'` splits vertically on purpose in `createLeafForOpen` whenever the active pane is claimed. Centre drop merges only if that pane already has an owner. Focus hides every live group whose parent is not the focused section, including root groups. Reconcile notifies the sidebar once per pass that actually changed data; a quiet pass does not.

### Cited Findings

#### Mode `'tab'` splits vertically when the pane is owned

- Comment on `openGroup`: “Mode `'tab'` never merges (D4): reuses an unowned active pane, else splits.” Comment on `createLeafForOpen`: “D4: 'tab' reuses unowned active pane, else vertical split. Never merges.” The owned branch is `createLeafBySplit(active, 'vertical')` with no direction argument from the caller. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 567–570 and 621–630
- `isPaneOwned` is true when any other group’s `homePaneId` equals that pane. Once any group is live, the usual most-recent main pane is owned, so row click, Enter, “Open all”, and “New tab” on a dormant group with the default behavior all take the vertical split. Default behavior is `{ mode: 'tab' }`, copied onto every `addGroup`, and the settings tab never edits it. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 386–395 and 599–600, [src/types.ts](D:/Repos/Obsidian/obsidian-tab-space/src/types.ts) lines 153–155, [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 246–259
- The menu label for that behavior is “New tab”. “New group” omits it, with a comment that a tab-mode new group would fall into the active pane and join its group. README line 46 says opening into an occupied pane merges. The function comments and the branch say vertical split and no merge. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 30–40, [README.md](D:/Repos/Obsidian/obsidian-tab-space/README.md) line 46
- Unowned branch claims the whole pane (`setHomePane`) after inserting one leaf. Membership can then `addTab` the pane’s other leaves into that group (or duplicate keys if a dormant group already lists them). That is an absorb of an unowned pane, not `mergeGroupInto`, and it does not push a merge receipt. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 602–616, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 184–232
- “Open all” fires one `openGroup` per dormant child without awaiting. Each call reads `getMostRecentLeaf()` and, on the owned path, splits vertically from whatever leaf is most recent at that moment. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 817–824

#### Centre-drop merge

- Centre zone calls `mergeGroupInto(sourceId, targetPaneId)` and returns. It does not split and does not call `openGroup`. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 808–811
- `mergeGroupInto` returns immediately when no group has `homePaneId === targetPaneId` (unowned pane, or the id does not match the pinned id). The drop handler has no fallback. The centre highlight is still applied; the “Merge into …” label is set only when a raw-id lookup finds an owner. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 639–645, [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 1120–1149
- When it does run: detach the whole source pane if it is live, move each restorable tab record, reopen those views as new leaves at the end of the target pane, delete the source group, Notice with Undo. Undo always `createLeafBySplit(targetLeaf, 'vertical')` and reopens whatever of those tab ids still exist. If the target pane is already gone, the notice says the group was restored as dormant. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 652–746
- Same-pane drop (`homePaneId === targetPaneId`) returns before the centre/edge branch. — lines 802–803
- A native drag can also emit `merged` + `removeGroup` + the same Undo notice, but only through membership step 5, which needs the source pane to still appear in the snapshot. The explicit centre drop does not depend on that. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 270–294, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 347–358
- `getPaneId` exists because `parent.id` “can churn across splits/drags.” The Open-menu merge passes the raw id into `mergeGroupInto`, which looks up owners by `homePaneId` (the pinned id). A churned id misses the owner and the merge returns. The centre drop path calls `getPaneId`, so it still sees the pinned id; its label lookup uses the raw id. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 22–36 and 639–645, [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 359–366 and 1125–1133

#### Focus hides panes outside the section

- `effectivelyHidden` is true when the group is `hidden`, or its section is `hidden`, or `focusedSectionId` is set and `group.parentId !== focusedSectionId`. A root group (`parentId: null`) is hidden whenever any section is focused. The test states that case. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 60–69, [src/membership.test.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.test.ts) lines 277–285
- Focus button and menu only write `focusedSectionId`. `main.ts` `onChange` calls `refreshHidden()` → `applyHiddenClass` → the `display: none` rules above, including collapsing splits that no longer contain a visible pane. Leaves stay in the workspace and in the snapshot. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 271–279 and 812–815, [src/main.ts](D:/Repos/Obsidian/obsidian-tab-space/src/main.ts) lines 20–25, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 467–470
- Sidebar, separately from panes: other sections render collapsed while one is focused (stored flags unchanged), and the focused section is moved first in the list. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 186–200 and 256–258
- `openGroup` on a group that is not a child of the focused section clears focus entirely (`setFocusedSection(null)`). It does not move focus to that group’s section. The following `refreshHidden` shows every pane that isn’t hidden by its own flags. — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 582–585
- Dragging a group to root (`moveInto(..., null)`) or into a different section changes `parentId` only. If a focus is active, the next `refreshHidden` hides or shows that group’s pane because `parentId !== focusedSectionId`. No split call. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 1045–1069, [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 66–68
- New panes created while focused are stored with `parentId: focusedSectionId`, so they are inside the focus and not hidden by this rule. — [src/membership.ts](D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts) lines 296–304
- On phone, the hide CSS does not apply (`body:not(.is-phone)`), so focus still sets the class and still collapses the sidebar’s other sections, and the main panes stay laid out. — [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css) lines 418–420

#### Reconcile notifying the sidebar

- Each store mutator ends in `save()` + `notify()`. `notify` runs every `onChange` listener: the view replaces the whole tree (`treeEl.empty()` then rebuild), and `main.ts` reapplies the tab-bar class, `refreshAccents`, and `refreshHidden`. — [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 135–189, [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 102–105 and 164–167, [src/main.ts](D:/Repos/Obsidian/obsidian-tab-space/src/main.ts) lines 20–25
- `store.batch` is the mitigation for reconcile only. The comment says an N-tab pass used to do N `saveData` serializations and N synchronous sidebar re-renders “on the same main thread that xterm.js needs to accept keystrokes and paint.” Batching makes one write and one `notify` if anything in the pass actually called `save`/`notify`. User actions such as `openGroup` are not wrapped in `batch`, so each `toggleHidden` / `setFocusedSection` / `setOpenBehavior` / `setHomePane` notifies on its own. — [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 135–163, [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 238–241
- Quiet pass: `syncTitle`, `syncViewState`, `setOrder`, and `setHomePane` return before `notify` when the value is unchanged. `setHomePane` still notifies when `homeLeafId` is set even if `homePaneId` already matches, specifically so the legacy field gets cleared; the comment says this guard exists so a poll tick does not re-render the sidebar. If no mutator dirties the batch, `batchPending` stays false and there is no `notify`. — [src/store.ts](D:/Repos/Obsidian/obsidian-tab-space/src/store.ts) lines 314–341, 366–376, and 411–421
- The 3s timer still builds a full plan. View-state capture is the expensive part that is skipped unless 30s have passed or the pass is `'full'` (`layout-change` is full). The comment on `trimViewState` says persisting Terminus scrollback made every unrelated write re-serialize it and made `syncViewState`’s equality check never succeed, “so every reconcile pass wrote the file and re-rendered the sidebar.” — [src/leaf-sync.ts](D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts) lines 45–70 and 192–205 and 266–268
- `applyHideTabHeaders` comments that it must not throw from a store listener because “reconcile notifies on the same path,” and it falls back to `activeDocument?.body` when `document.body` is missing (popout / early layout). — [src/main.ts](D:/Repos/Obsidian/obsidian-tab-space/src/main.ts) lines 47–54
- While an inline rename is open, the view’s listener skips `render()` so the input is not destroyed. Reconcile can still have notified; the pending data shows up when the rename finishes. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 102–104 and 708–712
- A separate sidebar refresh, not reconcile: `active-leaf-change` may `toggleCollapsed` on ancestors (that notifies and rebuilds the tree) and then move the sidebar highlight without taking keyboard focus. The comment says moving DOM focus here steals the keyboard from a terminal the user just clicked. — [src/views/TabSpacesView.ts](D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts) lines 106–140 and 576–588

Related layout pain already encoded next to the hide CSS: forcing `display: flex` on nested `.workspace-split` “breaks that height chain, so stacked panes collapse on load and only the side-by-side ones remain.” The shipped rule is `display: none` on fully hidden splits only. — [styles.css](D:/Repos/Obsidian/obsidian-tab-space/styles.css) lines 421–430

### Inferences

- The four pains are one stacking model. The catalog wants each group to own a pane, so “open as a tab” refuses to merge into an owned pane and splits right instead. The catalog also wants an explicit merge, so the centre of a pane is a second drop language on top of Obsidian’s, and it no-ops when the pane has no group. Focus is a third visibility tree (`focusedSectionId`) applied with `display: none`, so panes outside the section leave the flex layout while remaining real leaves. Every one of those store writes, plus every native drag that changes membership, funnels through `notify` and rebuilds the sidebar.
- “Recent” here means “still written as a scar in comments and branches,” not a commit date. The comments describe failures the current code is arranged to avoid (per-tab re-render, scrollback equality, flex on splits) and behaviors it still does on purpose (vertical split for owned `'tab'`, focus-as-hide, merge receipt on centre drop).

### Gaps

- Git history was not read, so there is no date for when the vertical-split branch, centre merge, focus hide, or `store.batch` landed.
- No runtime trace of how many `notify` calls one native drag produces (Obsidian may emit several `layout-change` events; the plugin coalesces overlapping reconciles to a single follow-up, then one notify if data changed).
