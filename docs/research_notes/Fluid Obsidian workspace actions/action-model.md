# Workspace action model

Recommendation only. The plugin should name panes the way Obsidian already names tab groups, and it should create or move leaves only when the user picks one of those verbs. Reconcile stays a recorder. Focus and Hide stay in the sidebar list and stop setting `display` on the split tree.

Installed app checked: `D:\Users\grego\AppData\Local\Programs\Obsidian\resources\obsidian.asar` (24,715,194 bytes). Strings below are from that archive (two copies of the same UI tables). Public help text is from the Obsidian Help extract, which disagrees with this install on the stack menu label.

## Which plugin verbs should be renamed or removed so they match Split right, Split down, Stack tabs, and Move to this tab group?

### Takeaway

Keep **Split right** and **Split down** as they are: the labels and the `createLeafBySplit` directions already match this install. Remove **New tab** from the open-placement menu, because that mode falls through to a vertical split. Rename **Open in current pane (merge)** to a move-into-tab-group action; this install has no command whose name is “Move to this tab group.” Add **Stack tabs** / **Unstack tabs** only as a toggle on an existing live tab group. Replace **Move to new group** with **Split right** and **Split down**. Rename **New window** to **Open in new window**.

### Cited Findings

- This install’s command table labels `splitRight` as “Split right”, `splitDown` as “Split down”, and `toggleStackedTabs` as “Toggle stacked tabs”. The same table labels neighboring tab-group navigation “Focus on tab group below”, “Focus on tab group to the left”, and “Focus on tab group to the right”. — [obsidian.asar command strings](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- The tab menu string table labels `stackTabs` as “Stack tabs” and `unstackTabs` as “Unstack tabs”, next to `moveToNewWindow` “Move to new window” and `openInNewWindow` “Open in new window”. — [obsidian.asar menu strings](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- Command ids in the same archive: `workspace:split-vertical` with label `splitRight()`, `workspace:split-horizontal` with label `splitDown()`, and `workspace:toggle-stacked-tabs` with label `toggleStackedTabs()` and icon `lucide-layers`. The tab context menu registers the two split commands in that order. Another command string is `moveToNewWindow`: “Move current tab to new window”, and `openInNewWindow`: “Open current tab in new window”. Close strings include “Close this tab group”, “Close others in tab group”, “Close all other tabs”, “Close all tabs”, and “Close current tab”. A separate string is `newWindow`: “New window”. — [obsidian.asar command registration](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- Searches of that archive found no string “Move to this tab group”, “Stack notes”, “Split left”, or “Split up”. The only “Move to this …” hit is the properties string “Move to this view”. The only “this tab group” hit is “Close this tab group”. — [obsidian.asar string search](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- Obsidian Help tells desktop users to right-click a tab and select **Split right** or **Split down** to create a new tab group, and says tabs can be dragged to another tab group. The same page says stacking is done from the down arrow at the upper right of a tab group, with the item **Stack notes**, and that “Tab stacks are, at their heart, the same as a tab group.” The 1.0.0 changelog uses the same claim: a tab stack is a way to view a tab group, and a tab group and a tab stack can sit side by side. — [Tabs - Obsidian Help](https://obsidian.md/help/tabs); [Obsidian 1.0.0 changelog](https://obsidian.md/changelog/2022-10-13-desktop-v1.0.0/)
- Help’s sidebar page says that when only the tab area of a tab group is highlighted, the dragged tab merges with the tabs already in that group. — [Sidebar - Obsidian Help](https://obsidian.md/help/sidebar)
- In this install, `.workspace-split` is `display:flex`. `.workspace-split.mod-vertical` is `flex-direction:row`, and its children are `height:100%; flex:1 0 0; width:0`. `.workspace-split.mod-horizontal` is `flex-direction:column`, and its children are `width:100%; flex:1 0 0; height:0`. Stacked tabs are a class on the tab group, `.workspace-tabs.mod-stacked`, not a split direction. — [obsidian.asar app CSS](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- `createLeafBySplit(leaf, direction, before)` calls `splitLeaf`. `splitLeaf` defaults direction to `"vertical"`. When the new direction differs from the parent split, it wraps the leaf in a new split of that direction and inserts the new leaf first when `before` is true. Native tab drag maps top/bottom to `"horizontal"` and left/right to `"vertical"`, with `before` for left or top. A center drop on a tab group inserts the leaf into that group at `getTabInsertLocation(clientX).index`. — [obsidian.asar splitLeaf and tab drag](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- The plugin’s open menu is exactly: “Split right” `{ mode: 'split', direction: 'vertical' }`, “Split down” `{ mode: 'split', direction: 'horizontal' }`, “New window” `{ mode: 'window' }`, “New tab” `{ mode: 'tab' }`. The new-group row uses that list without “New tab”. — [TabSpacesView.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts)
- Split mode calls `createLeafBySplit(anchor, direction)` with the most recent leaf as anchor. Window mode calls `getLeaf('window')`. — [leaf-sync.ts createLeafFor](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts)
- Mode `'tab'` reuses the active pane when that pane is unowned (`createLeafInParent`), and otherwise calls `createLeafBySplit(active, 'vertical')`. The stored default is `{ mode: 'tab' }`. — [leaf-sync.ts createLeafForOpen](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts); [types.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/types.ts)
- The open button’s extra item is titled “Open in current pane (merge)” and calls `mergeGroupInto` on the most recent leaf’s pane. The center workspace drop calls the same merge. — [TabSpacesView.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts); [leaf-sync.ts mergeGroupInto](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts)
- The group menu item “New tab” calls `addBlankTab`, which inserts one leaf in the group’s existing parent. The tab menu item “Move to new group” calls `moveTabToNewGroup`, which always uses `createLeafBySplit(anchor, 'vertical')`. “Move to: {title}” calls `moveTab` for every other group, live or dormant. “Close group” detaches the pane’s leaves and clears `homePaneId`, leaving the stored tabs in place. Undo of a merge reopens the restored group with `createLeafBySplit(targetLeaf, 'vertical')`. — [TabSpacesView.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts); [leaf-sync.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts)
- The plugin has no Stack tabs action. A group is defined as a claim on one pane (`homePaneId`). — [CONTEXT.md](file:///D:/Repos/Obsidian/obsidian-tab-space/CONTEXT.md)
- Nielsen’s consistency heuristic: users should not have to wonder whether different words or actions mean the same thing; follow platform conventions. The same article states Jakob’s Law: time spent in other products sets expectations. The “match the real world” heuristic says to use the user’s familiar words rather than internal jargon. A 1989 CHI workshop recommendation was to emulate a small set of exemplary applications so new applications look and act like them. — [Consistency and standards (NN/G)](https://www.nngroup.com/articles/consistency-and-standards/); [Ten usability heuristics (NN/G)](https://www.nngroup.com/articles/ten-usability-heuristics/); [Coordinating user interfaces for consistency](https://doi.org/10.1145/67900.67910)
- Instrumental interaction treats a command as an instrument that acts on an existing object of interest. Polymorphism asks that the same instrument apply wherever that object appears. — [Instrumental interaction](https://doi.org/10.1145/332040.332473); [Designing Interaction, not Interfaces](https://perso.lisn.upsaclay.fr/mbl/papers/AVI2004/paper.pdf)

### Inferences

- **Split right** and **Split down** stay, with the current direction arguments. In this install those arguments are the ones native drag already passes to `splitLeaf`: vertical means a row (side by side), horizontal means a column (one pane under another).
- **New tab** leaves the placement menu. The host’s New tab is a leaf inside the current tab group. The plugin’s mode `'tab'` does that only when the active pane is unowned; an owned pane becomes Split right with no Split right label. The group menu item that inserts a blank leaf in the group’s own pane can keep the label **New tab**.
- **Open in current pane (merge)** becomes **Move into current tab group**. The host never names this “merge” in the command table. The behavior that matches the help page and the center-drop code is inserting leaves into the target tab group. “This tab group” fits a drag that is already over a group; a menu needs “current”, because the target is the most recent leaf. Keep the explicit gesture: dormant open still must not take this path unless the user picks it.
- **Stack tabs** is not a fifth open placement and not a synonym for Split down. Split down creates a `mod-horizontal` split. Stack tabs toggles `mod-stacked` on the tab group that already exists. Offer **Stack tabs** / **Unstack tabs** on a live group’s menu, aimed at that group’s pane, after that pane is the active tab group so `workspace:toggle-stacked-tabs` has the right target. Leave it off the dormant Open menu.
- **Move to new group** becomes two items, **Split right** and **Split down**, each moving that one tab with `createLeafBySplit` in the matching direction. **Move to: {title}** stays only for a live target, labeled **Move to {title}**, and only inserts into that tab group. A dormant title is a list filing, not a split.
- **New window** on the new-group and open menus becomes **Open in new window**, matching the menu string for a new popout. **Move to new window** is the host phrase for a tab that already exists; use it only if the action moves current leaves into a popout.
- **Close group** should keep a distinct label. The host’s “Close this tab group” does not leave a dormant list behind. Reusing that sentence would make one phrase mean two outcomes.
- **Undo last merge** can stay, and the reopen beside the target should be an explicit Split right (`'vertical'`) so the direction the code already hardcodes is the verb the user can recognize.

### Gaps

- The full Obsidian Help HTML did not come back from a page fetch; the Help quotations are from the search extract of those URLs. That extract says “Stack notes”; this install’s menu says “Stack tabs”. The install is the naming source for the plugin.
- The body of `workspace:toggle-stacked-tabs` was truncated in the archive slice, so it is not confirmed here whether the command always toggles `activeLeaf`’s parent. The id, the user-facing name, and the menu pair Stack tabs / Unstack tabs are confirmed.
- The archive was not searched for the exact plugin sentences “Move to new group” and “Open in current pane (merge)”. They are absent from the command and menu tables that were extracted.
- Obsidian’s marketing version number was not read out of the install.

## When should the plugin mutate the workspace at all, versus only recording what Obsidian already did?

### Takeaway

Mutate the workspace only after an explicit host placement or close: Split right, Split down, Open in new window, Move into current tab group, New tab inside a live group, Stack tabs on that live group, and Close of that group’s leaves. On load, on layout change, and after any native drag, only record. Reconcile already does the recording and does not create splits.

### Cited Findings

- `onload` loads the store, calls `leafSync.start()`, and toggles a body class for hiding tab headers. It does not call `openGroup` or `createLeafBySplit`. A store change refreshes accents and hidden classes. — [main.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/main.ts)
- Reconcile listens to `layout-change`, snapshots main-area panes, and applies a pure plan: claim, release, retitle, move tab records, add, prune, new group records, and a merge receipt. `applyPlan` only writes the store. After the plan, each live group gets its hidden class and accent. — [leaf-sync.ts doReconcile and applyPlan](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts); [membership.ts plan](file:///D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts)
- The product rule already says the workspace is the source of truth for membership, and opening a dormant group never merges unless the user chooses the merge item or the center drop. — [CONTEXT.md](file:///D:/Repos/Obsidian/obsidian-tab-space/CONTEXT.md)
- Paths that do create leaves: `openGroup` when the home pane is gone, `openNewGroup`, `mergeGroupInto`, `openGroupAtDropTarget` (which closes a live group first), `moveTabToNewGroup`, `undoMerge`, and `addBlankTab`. Live `openGroup` only `revealLeaf`s. Mode `'tab'` with an owned active pane creates a vertical split. — [leaf-sync.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts)
- Row click, Enter, and section **Open all** call `openGroup` with no placement override, so they use the group’s saved behavior or the default mode `'tab'`. — [TabSpacesView.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts); [types.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/types.ts)
- `focusedSectionId` is restored from saved data. A group is treated as hidden when its own flag is set, its section’s flag is set, or some other section is focused. — [store.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/store.ts); [membership.ts effectivelyHidden](file:///D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts)
- Native drop already mutates the split tree itself: edge drops call `splitLeaf`, center drops `insertChild` into the tab group. — [obsidian.asar tab drag](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)

### Inferences

- Load and `layout-change` should keep doing what `applyPlan` does now: claim a pane that is already there, release a pane that is gone, file tabs under the group that owns that pane, and create a group record for an unclaimed pane. They should not call `createLeafBySplit`, `detach`, or `display` changes.
- A native Split right, Split down, stack toggle, tab drag, or close is already the mutation. The next reconcile is the record. The sidebar drag of a live group should not close that pane and rebuild it.
- The plugin creates leaves when the user asks to place something that has no leaf yet (a dormant group or a blank tab) or asks to move stored tabs into a named tab group. Each of those calls is one host verb, with the direction visible in the label.
- Row click, **Open all**, and mode `'tab'`’s owned-pane branch should stop creating splits. Those are the unlabelled vertical mutations. A dormant row click opens the placement menu. **Open all** leaves the section menu, because each dormant group would otherwise need its own placement and the current loop supplies none.
- Saving `openBehavior` is fine after the user actually picks Split right, Split down, or Open in new window. Saving mode `'tab'` after a silent vertical fallback records a placement the user did not see.

### Gaps

- `LeafSync.start` was not read line by line, so the first reconcile timing on cold start is inferred from `onload` calling `start()` and from `layout-change` calling `reconcile`, not from a quoted `start()` body.
- Whether every `hidden` flag round-trips through the data file was not checked past the node model and `focusedSectionId` being restored. The hide effect on load is visible in code once reconcile runs, because `doReconcile` applies the class from those flags.

## How should drag-and-drop zones map onto Obsidian’s own drop zones instead of a custom overlay that merges on centre drop?

### Takeaway

Stop drawing the five-zone overlay. Sidebar drags only reorder or refile records. A drop onto the workspace, if it stays at all, should use Obsidian’s own edge test and the same `splitLeaf` direction map, and a center hit should insert into that tab group the way native center drop does. The center of the pane is not a merge button.

### Cited Findings

- Native `getDropDirection` starts at `"center"`. An edge wins only when its fractional distance is under `0.33` and nearer than the current winner. On a tab group that is not stacked, a pointer over the tab header sets the running distance to `0` (later edges cannot win); the top third of the header height is `"top"`, and the rest of that header is `"center"`. On a stacked tab group, left and right are removed from the candidates when the pointer is outside the tab header. The preview rect for a winning edge is `max(side/3, 40px)` on that edge. Center on a tab group replaces the preview rect with `getTabInsertLocation(clientX).rect` and the drop `insertChild`s into that group. Edge drops call `splitLeaf` with horizontal for top/bottom, vertical for left/right, and `before` for left or top. The preview nodes are `workspace-drop-overlay` and `workspace-fake-target-overlay`. — [obsidian.asar getDropDirection and tab drag](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- The plugin’s workspace drag uses a 25% band on each edge and treats everything inside as `'center'`. Center sets `data-working-tabs-merge-target` to `Merge into ${owner.title}` and calls `mergeGroupInto`. Edges call `createLeafBySplit` with horizontal for top/bottom, vertical for left/right, and `before` for top/left, after closing the group if it was live. The overlay is a `::after` on `.workspace-tabs`: 25% strips, and a center box inset 10% that shows the merge sentence. — [TabSpacesView.ts registerWorkspaceDropZones](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts); [leaf-sync.ts openGroupAtDropTarget](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts); [styles.css](file:///D:/Repos/Obsidian/obsidian-tab-space/styles.css)
- Sidebar row drops use before / after / into to refile a group under a section or a tab under a group. Into a group calls `moveTab`. — [TabSpacesView.ts handleDrop](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts)
- Help describes drop zones as highlights that decide where a tab is inserted, and describes a split by dragging a tab to the bottom of another tab. The sidebar page says a highlight limited to the tab area means the tab joins that group. — [Tabs - Obsidian Help](https://obsidian.md/help/tabs); [Sidebar - Obsidian Help](https://obsidian.md/help/sidebar)
- Hiding tab headers sets `display: none` on `.mod-root .workspace-tab-header-container`. Native direction testing reads `tabHeaderContainerEl` geometry. — [styles.css](file:///D:/Repos/Obsidian/obsidian-tab-space/styles.css); [obsidian.asar getDropDirection](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)

### Inferences

- The edge direction map in `openGroupAtDropTarget` already matches native `splitLeaf`. The hit areas do not. 25% bands plus a large center merge rectangle are a second drop language on top of the host’s 33% competition, header exception, and tab-slot highlight.
- The smallest faithful drag model has two layers. Inside the sidebar, before / after / into stay list operations and never call `createLeafBySplit`. On the workspace, delete the custom classes, the `::after` overlay, and the “Merge into” attribute.
- If a dormant group can still be dropped on a pane, test the pointer with the same rules as `getDropDirection`: default center; an edge only inside 0.33 and only if it is the nearest; on an unstacked tab group, the header is center except the top third of the header height, which is Split up. Top/bottom pass `'horizontal'`; left/right pass `'vertical'`; left and top pass `before: true`. Center calls `createLeafInParent` on that tab group’s parent for each stored tab (move into this tab group) and does not close or rebuild a split. A stacked group does not grow left/right splits from a drop on the note body.
- A live group’s workspace geometry stays under Obsidian’s own tab drag. The sidebar should not close that pane and reopen it, because that sequence deletes a flex child and then inserts a new split, which is a second layout pass the host drag does as one `splitLeaf` or `insertChild`.
- While tab headers are `display: none`, the header test that distinguishes Split up from “move into this tab group” has no box to hit. Leaving the header row visible is what lets the host zones and Stack tabs keep their targets. The hide-tab-bar setting is a chrome override, separate from Hide pane, and it fights those zones.

### Gaps

- `getTabInsertLocation`’s exact rectangle math was not extracted, only its use as the center preview and the insert index.
- There is no public plugin API in the repo that draws `workspace-drop-overlay`. Matching the zones means copying the threshold rules and calling `createLeafBySplit` / `createLeafInParent`, not handing the drag to Obsidian’s private drag manager. That private manager was read from the asar; calling it from the plugin was not verified and is out of scope.
- Native behavior when several tab groups are stacked (`isStacked`) was only read for the left/right exclusion. The visual of a stacked drop was not exercised in the app.

## What should Focus, Hide, and Open do so they do not collapse or restyle the split tree?

### Takeaway

Focus only reveals tab groups that are already open and filters the sidebar list. Hide stops setting `display` on panes and on ancestor splits; tucking a pane away is Close, which uses `detach` so Obsidian reflows. Open on a live group only reveals it. Open on a dormant group waits for Split right, Split down, Open in new window, or Move into current tab group.

### Cited Findings

- `.workspace-split.mod-vertical > *` is `height:100%; flex:1 0 0; width:0`. `.workspace-split.mod-horizontal > *` is `width:100%; flex:1 0 0; height:0`. — [obsidian.asar app CSS](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- The plugin’s hide rule sets `.workspace-tabs.working-tabs-hidden-pane` to `display: none`, and sets a `.workspace-split` to `display: none` when every `.workspace-tabs` inside it is hidden. The comment above that rule says a previous rule forced `display:flex` on every nested split and that this broke the height chain, so stacked panes collapsed and only side-by-side panes remained. The current stylesheet does not contain that `display:flex` override. A separate rule sets `.mod-root .workspace-tab-header-container` to `display: none` when the hide-tab-bar body class is on. — [styles.css](file:///D:/Repos/Obsidian/obsidian-tab-space/styles.css)
- `effectivelyHidden` is true when the group is hidden, its section is hidden, or `focusedSectionId` is set and the group is filed elsewhere. `applyHiddenClass` toggles `working-tabs-hidden-pane` on that pane. Reconcile applies it to every live group. `openGroup` clears the group and section hidden flags and clears `focusedSectionId` when the group is outside the focused section, then reveals a live pane or creates leaves. — [membership.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/membership.ts); [leaf-sync.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts)
- The section row button and the section menu both set `focusedSectionId`. The eye button calls `toggleGroupHidden` or `toggleSectionHidden`. While a section is focused, other sections render collapsed in the sidebar. The host uses “Focus on tab group …” for moving attention between tab groups. — [TabSpacesView.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts); [obsidian.asar command strings](file:///D:/Users/grego/AppData/Local/Programs/Obsidian/resources/obsidian.asar)
- `closeGroup` detaches each leaf in the pane and clears `homePaneId`. It does not change split CSS. — [leaf-sync.ts closeGroup](file:///D:/Repos/Obsidian/obsidian-tab-space/src/leaf-sync.ts)
- Accent stripes use a `::before` on `.workspace-tabs` and do not set `display` or `flex-direction` on `.workspace-split`. — [styles.css](file:///D:/Repos/Obsidian/obsidian-tab-space/styles.css)

### Inferences

- **Focus** keeps the word only for attention, which is what the host’s “Focus on tab group …” commands do. Focusing a section expands that section in the list, optionally moves it to the top of the list as it does now, and `revealLeaf`s the section’s live groups. It does not set `focusedSectionId` into `effectivelyHidden`, does not add `working-tabs-hidden-pane`, and does not clear other sections’ panes. Sidebar collapse of unfocused sections can stay; that is list chrome.
- **Hide** stops writing workspace CSS. Delete the `display: none` rules on `.workspace-tabs.working-tabs-hidden-pane` and on ancestor `.workspace-split`. `display: none` removes a flex item; on a `mod-horizontal` split the remaining children still have `height: 0` and grow by flex, and a fully hidden nested split disappears from its parent row, which is how a column of panes turns into a row of whoever is left. The old `display:flex` override is already gone; it should stay gone, because a nested split needs the install’s `flex-direction` plus the `height: 0` / `width: 0` child rules, not a new `display`.
- Putting a pane away is the existing **Close group** path: `detach` the leaves, keep the dormant record, let Obsidian recompute the split. The eye buttons go away so Hide is not a second layout engine. Section “Hide all” goes with them. “Close all” can stay in the section menu as repeated `closeGroup`, because that is leaf removal through the workspace API.
- **Open** on a live group is `revealLeaf` only, including when the user clicks the row. It does not unhide ancestors, clear focus, or split. **Open** on a dormant group shows Split right, Split down, Move into current tab group, and Open in new window, and runs `createLeafBySplit` or `createLeafInParent` only after that choice. It does not call the mode `'tab'` vertical fallback.
- The colour stripe can stay. It does not change the split’s `display` or `flex-direction`.

### Gaps

- The “panes end up vertical on load” report was not reproduced in a running Obsidian window in this pass. The mechanisms that can produce it are in the repo and the asar: persisted focus/hide plus `display: none` on splits, and unlabelled `createLeafBySplit(..., 'vertical')` on open. Which one a given user hits was not observed.
- No measurement was made of how Obsidian redistributes `dimension` after `leaf.detach()`. The recommendation uses `detach` because that is the API the plugin already uses for close, and because the CSS hide path is the one that overrides the split’s own `display`.

## What is the smallest UI change (row actions, menus) that makes the correct action obvious?

### Takeaway

Change the menus in place. Do not add a new layout control. The dormant Open menu lists four host verbs. The live row drops the eye button and gains Stack tabs only inside More. Section rows drop Focus-as-hide and Hide-all. The workspace merge overlay goes away. Sidebar reorder stays.

### Cited Findings

- Dormant group row actions are Open (the placement menu), Complete, and More. Live group row actions are the eye (Hide pane / Unhide pane), Complete, and More. Section row actions are the crosshair (Focus section / Unfocus section), the eye (Hide all / Unhide all), and More. The new-group row opens Split right, Split down, and New window. — [TabSpacesView.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts)
- More for a group already contains New tab, Close group, Undo last merge, Rename, Edit description, Colour, and Delete permanently. The section menu contains Focus, Open all, Close all, and the rename/description/colour/delete items. The tab menu contains done-state, Move to new group, Move to: {title} for every other group, and Close tab. — [TabSpacesView.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts)
- Workspace highlighting is a document-level drag listener that paints `working-tabs-pane-drop-*` on `.mod-root .workspace-tabs`. — [TabSpacesView.ts](file:///D:/Repos/Obsidian/obsidian-tab-space/src/views/TabSpacesView.ts); [styles.css](file:///D:/Repos/Obsidian/obsidian-tab-space/styles.css)
- Consistency guidance is that one word should mean one action, and that a satellite surface should copy the exemplary host rather than invent a parallel vocabulary. An instrument is supposed to act on the host object the user already sees. — [Consistency and standards (NN/G)](https://www.nngroup.com/articles/consistency-and-standards/); [Coordinating user interfaces for consistency](https://doi.org/10.1145/67900.67910); [Instrumental interaction](https://doi.org/10.1145/332040.332473)

### Inferences

- One Open button remains on a dormant group. Its menu is the whole placement UI: **Split right**, **Split down**, **Move into current tab group**, **Open in new window**. Remove **New tab** and **Open in current pane (merge)** from that menu. Clicking the dormant row opens this same menu instead of calling `openGroup()` with the default. A live row click still only reveals the pane, so the Open button stays off live rows, which is how the view is written today.
- The new-group row menu becomes **Split right**, **Split down**, **Open in new window**. That row already creates an empty pane and lets reconcile name the group; only the third label changes.
- Remove the eye button from group rows and from section rows, and remove “Hide all groups in this section” from the section menu. Remove the crosshair, and remove Focus / Unfocus from the section menu, unless Focus is reduced to “reveal this section’s live tab groups” with no hidden class. Leaving a crosshair that hides other panes keeps the host word “Focus” attached to a layout change. The chevron already folds the list.
- Remove **Open all**. **Close all** can remain in the section More menu as batch `closeGroup`.
- On a live group’s More menu, add **Stack tabs** or **Unstack tabs** according to whether that pane already has stacked tabs. It toggles the existing tab group. It is not a row icon, so the row does not grow a new layout control.
- The tab More menu replaces **Move to new group** with **Split right** and **Split down**, and lists **Move to {title}** only for live groups.
- Delete `registerWorkspaceDropZones` and the pane-drop CSS. Dragging inside the sidebar keeps before / after / into. Users who want a split see the verb in the Open menu, which is the same verb as the tab context menu in the workspace. A later drop that copies `getDropDirection` can be added on top of those same four verbs; it is not required for the verbs to be obvious.
- No new workspace type, no split-tree walker, and no second overlay. The calls stay `createLeafBySplit`, `createLeafInParent`, `getLeaf('window')`, `revealLeaf`, `detach`, and the existing reconcile plan.

### Gaps

- This pass did not implement or click through the menus in Obsidian, so the recommendation is from the source and the installed strings, not from a usability session.
- Whether the stacked state is readable as `mod-stacked` on the group’s `.workspace-tabs` from the plugin view was inferred from the asar CSS class, not from a plugin API field in this repo. The repo has no stack flag today.
