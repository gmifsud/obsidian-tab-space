# PRD + implementation plan: Membership module, reversible Merge, Section focus

Repo: `D:\Repos\Obsidian\obsidian-tab-space` (Obsidian plugin "Working tabs"). Source: `src/leaf-sync.ts`, `src/store.ts`, `src/types.ts`, `src/views/TabSpacesView.ts`, `src/main.ts`. No tests, no `CONTEXT.md`, no ADRs exist today.

## Goal

Polish tab-group management so that:

1. Tabs are never silently absorbed into another group with their record destroyed, and any merge can be undone.
2. A Group, hidden or not, always represents exactly the set of tabs in its pane (no ghost/empty groups, no stale lists while live).
3. A Section has a job: it is the scope you are working in (Focus), new panes file into it, and it opens/closes its groups as one unit.

Phased: **A** (Membership) -> **B** (reversible Merge + single-tab escape) -> **D** (Section focus). Each phase ships independently; B and D depend on A.

## Glossary (seed for `CONTEXT.md`, create it in phase A)

- **Tab** - one stored record (`SpaceNode.type === 'tab'`) tracking one leaf by `tabKey` (file path, or `viewType:leafId` for non-file views).
- **Pane** - an Obsidian tab container (`leaf.parent`, a `WorkspaceTabs`) in the main area. Has a runtime `id` (undocumented, same status as `leaf.id`).
- **Group** - a stored node that *claims one pane*. States: **live** (claims an existing pane), **dormant** (claims nothing; tab list intact, reopenable), **hidden** (live, pane `display:none`), **completed** (under `__completed__`).
- **Section** - a folder of groups representing a timeframe. May be **focused** (at most one).
- **Merge** - moving every live tab of group H into the pane of group G; H is removed and a **MergeReceipt** is kept for Undo.
- **Membership** - the rule deciding which group each live leaf belongs to, computed as a pure **plan** from a **WorkspaceSnapshot**.

## Decisions (resolved with the user)

| # | Decision |
|---|---|
| D1 | Workspace is the source of truth for membership. When a leaf appears in a pane owned by G but its record is under H, the record is **moved** (`moveTabRecord`), never deleted and re-created. `done`, `titleOverridden`, title and id survive. |
| D2 | A Group claims a **pane** (`homePaneId = leaf.parent.id`), not an anchor leaf. `homeLeafId` is migrated on load and then dropped. No anchor drift, no claim collisions. |
| D3 | If a pass moves every non-done tab out of H into G, the plan emits `merged(H -> G, tabIds, snapshotOfH)` then `removeGroup(H)`. Done-only groups stay alive (current rule). |
| D4 | Opening a dormant group **never merges implicitly**. `OpenBehavior.mode === 'tab'` is redefined as "reuse the active pane if it is unowned, else split (vertical)". Merge is only reachable through two explicit verbs: group menu **Open in current pane (merge)** and drop on a pane's **centre** zone. No stored default can merge. |
| D5 | Membership is a **pure function** `plan(snapshot, nodes, ctx) -> Plan` plus a thin applier in `LeafSync` that runs the plan inside one `store.batch` and then re-asserts hidden class / accent per claimed pane. |
| D6 | Test runner: **Vitest**. Tests in `src/**/*.test.ts`; plan tests need no Obsidian import. |
| D7 | Dormant reattach is **exact**: a dormant group reattaches to an unclaimed pane only if every one of its non-done tabs is present in that pane. Otherwise the pane becomes a new group and the dormant group stays dormant. |
| D8 | PRD scope = A + D4 + B-minimal + D. |
| D9 | Merge receipts are **session-scoped, in memory** (stack of last 5). Undo is offered on the merge Notice (button in `noticeEl`) and as **Undo last merge** in the target group's menu while a receipt for it exists. |
| D10 | Single-tab escape: tab menu **Move to...** goes through the same placement path as sidebar drag (record + leaf), and a new **Move to new group** item opens a split with just that tab. |
| D11 | Section verbs: **Focus**, **File new groups** (while focused), **Open all / Close all**. Not in scope: Complete section. |
| D12 | Focus is **derived**: `focusedSectionId` stored once on `TabSpacesData`; `isEffectivelyHidden(group) = group.hidden \|\| section.hidden \|\| (focused && group.parentId !== focused)`. Opening a group outside the focused section **unfocuses**. |

Minor decisions made by the planner (consistent with the above): the pane drop overlay shows a text label "Merge into <group>" when hovering the centre zone (CSS `::after` from a `data-` attribute), zone geometry unchanged; `openingGroups` suppression becomes a plan input (`suppressedGroupIds`) so the plan simply emits no entries for those groups.

## Data model changes (`src/types.ts`)

- `SpaceNode.homePaneId?: string` (groups only) replaces `homeLeafId`. Keep `homeLeafId` in the type as `@deprecated` for one release for migration only.
- `TabSpacesData.focusedSectionId?: string | null`.
- New types (new file `src/membership.ts`):
  - `WorkspaceSnapshot = { panes: Array<{ paneId: string; leaves: Array<{ leafId: string; identity: { key: string; path?: string; title: string }; viewState?: ViewState }> }> }` - traversal order preserved; sidebars and this plugin's own view excluded; `viewState` present only on `'full'` passes (trimmed).
  - `PlanContext = { mode: 'full' | 'poll'; focusedSectionId: string | null; suppressedGroupIds: ReadonlySet<string>; nextDefaultTitle: () => string }`.
  - `PlanEntry` union: `claimPane{groupId,paneId}` · `releasePane{groupId}` · `syncTitle{tabId,title}` · `syncViewState{tabId,viewState}` · `setOrder{tabId,order}` · `moveTabRecord{tabId,fromGroupId,toGroupId}` · `addTab{groupId,key,path?,title,viewState?}` · `pruneTab{tabId}` · `newGroup{paneId,parentId,title}` · `merged{fromGroup: SpaceNode, toGroupId, tabIds}` · `removeGroup{groupId}`.
  - `MergeReceipt = { group: SpaceNode; tabIds: string[]; targetGroupId: string; at: number }` (in `LeafSync`, not persisted).
- Migration in `TabSpacesStore.load()`: nothing to do for `homeLeafId -> homePaneId` at load time (leaf ids are dead after restart anyway); in the first reconcile pass, `applyPlan` treats groups with `homeLeafId` but no `homePaneId` as dormant, then clears `homeLeafId`. Existing `defaultOpenBehavior: {mode:'tab'}` needs no migration (D4 redefines the mode).

## Membership plan rules (`src/membership.ts`, pure)

Order of evaluation, each producing entries:

1. **Live sync** - for every leaf whose key matches a stored tab: `syncTitle`; `syncViewState` when `mode === 'full'` (poll passes: caller decides via the existing 30 s interval and sets `mode` accordingly).
2. **Claims** - group with `homePaneId` present in snapshot keeps it (`claimPane`); group whose `homePaneId` is absent: `releasePane` (dormant). Blank tabs (`isBlankTab`) of a released group -> `pruneTab`; if nothing remains -> `removeGroup`.
3. **Reattach** (D7) - for each unclaimed pane, the first dormant group (store order) whose non-done tab keys are all present in that pane -> `claimPane`.
4. **Mirror** (D1) - for each claimed pane (skip `suppressedGroupIds`):
   - leaf key already recorded under this group -> keep;
   - leaf key recorded under another *live* group H -> `moveTabRecord(H -> G)`;
   - leaf key recorded under a *dormant* group -> `addTab` here (dormant lists are never mutated by other panes' contents);
   - leaf key recorded nowhere -> `addTab`;
   - recorded non-done tab whose key is not in the pane and was not moved out -> `pruneTab`.
   - then `setOrder` to mirror the tab strip (live first, then done/closed in their relative order).
5. **Merge detection** (D3) - any live group H that lost all its non-done tabs via `moveTabRecord` to a single G this pass -> `merged(H -> G)` then `removeGroup(H)` (H's pane, if still present with nothing of H in it, is released first).
6. **New groups** - each still-unclaimed pane -> `newGroup{parentId: ctx.focusedSectionId ?? null}` + its `addTab`s.

Invariants to assert in tests: every live group's recorded non-done tab keys == its pane's leaf keys after apply; no tab record is ever removed and re-added with the same key in one plan; no two groups claim the same pane; a dormant group's tab list is never changed by a pass.

## Phase A - Membership module (deepen reconcile)

Tasks:

1. Add Vitest: `npm i -D vitest`; `"test": "vitest run"` in `package.json`; keep `tsconfig` `include` as is (tests type-check, never bundle).
2. Create `src/membership.ts` with the types above and `plan()`; port the four reconcile steps as the rules above. No `obsidian` import.
3. In `src/leaf-sync.ts`: add `snapshot(mode)` (wraps `iterateAllLeaves`, identity, `readViewState` cache, pane id via `leaf.parent.id`); add `applyPlan(plan)` (switch over entries -> existing store mutators plus new `store.moveTabRecord`, `store.setHomePane`); replace `doReconcile` with `snapshot -> plan -> apply`; after apply, `applyHiddenClass` + `applyAccent` for each claimed pane. Delete steps 1-4 and `syncGroupTabs`.
4. In `src/store.ts`: add `moveTabRecord(tabId, toGroupId)` (reparent, append order) and `setHomePane`; replace every `homeLeafId` read (`isLive`, `closeGroup`, `addBlankTab`, `closeLiveTabOnly`, `countLiveSiblingsBefore`, `reopenTab`, `relocateLiveLeaf`, `findOwningGroup`, `openGroupAtDropTarget`) with a `paneById(homePaneId)` helper that resolves the pane by iterating leaves and matching `leaf.parent.id`. Remove dead `groupByHomeLeaf`, `completed` getter.
5. D4: in `openGroup`, mode `'tab'` -> if the active pane is unowned, open there; else `createLeafBySplit(active, 'vertical')`. Delete the implicit `owner` merge branch. Add `mergeGroupInto(sourceId, targetPaneId)` as the single explicit merge implementation used by the new **Open in current pane (merge)** menu item and by `openGroupAtDropTarget` centre zone.
6. Create `CONTEXT.md` at repo root with the glossary above.
7. Tests (`src/membership.test.ts`), fixtures as plain objects: restart reattach exact / partial; native drag of a non-anchor tab between two live panes (record moves, done survives); drag of *every* tab of H into G (`merged` + `removeGroup`); closing the last tab (release, dormant, list intact); blank-pane cleanup; suppressed group untouched; focused section filing of `newGroup`; poll vs full `syncViewState`.

Acceptance: all existing README behaviours hold (manual pass over Features list); `npm test` green; `npm run build` green; the words "merged into" never appear from a plain click on a dormant group.

## Phase B - Reversible Merge + single-tab escape

Tasks:

1. `LeafSync.receipts: MergeReceipt[]` (max 5). `applyPlan` on `merged` pushes a receipt (uses the `fromGroup` snapshot and `tabIds`). `mergeGroupInto` also goes through the plan path so both explicit verbs yield one receipt.
2. Merge Notice: build with `new Notice('', 0)`, set text and append an **Undo** button to `notice.noticeEl`; button calls `undoMerge(receipt)`.
3. `undoMerge(receipt)`: re-create the group from `receipt.group` (same id, title, description, colour, `parentId` if it still exists else root, order appended); `store.moveTabRecord` each surviving `tabId` back; close those tabs' leaves in the target pane (`closeLiveTabOnly`); open the restored group via `createLeafBySplit(targetPane's leaf, 'vertical')` with `openingGroups` suppression (same close+reopen pattern as `openGroupAtDropTarget`). Pop the receipt. Tabs the user closed since the merge are skipped.
4. Group menu: **Undo last merge** when a receipt targets this group.
5. D10: add `LeafSync.moveTab(tab, toGroupId, index)` = `store.moveInto` + `relocateLiveLeaf` (or `reopenTab` if the target is live and the tab is not open; no-op leaf side if target is dormant). Route sidebar drop (`handleDrop`/`afterTabMove`) and the **Move to...** menu through it. Add **Move to new group**: create a split next to the tab's current pane, create the group record, then `moveTab`.
6. Drop-zone label: `data-working-tabs-merge-target="<title>"` on the pane element while hovering centre; CSS `::after` renders "Merge into <title>".
7. Tests: receipt creation on `merged`; undo round-trip on an in-memory store (records back under the restored id); `moveTab` record+leaf agreement is manual (needs Obsidian).

Acceptance: merge by either explicit verb shows a Notice with Undo; Undo restores the group with its name/colour/section and its tabs in a new pane next to the target; **Move to...** on a live tab is not reverted by the next reconcile; **Move to new group** yields a new live group with that single tab.

## Phase D - Section focus, filing, open/close all

Tasks:

1. `TabSpacesData.focusedSectionId`; `store.setFocusedSection(id | null)`; `store.focusedSectionId` getter.
2. `LeafSync.isEffectivelyHidden` per D12; `refreshHidden()` that re-applies the hidden class to every live group (called from the store change listener in `main.ts`, next to `refreshAccents`).
3. `openGroup`: if the group is outside the focused section, `setFocusedSection(null)` before revealing (D12), in addition to the existing clear-hidden logic.
4. `plan()` already receives `focusedSectionId` (Phase A) - verify `newGroup.parentId` filing with a test.
5. Section row: a **Focus** toggle button (hover action next to Hide); focused section renders first with a visible "focused" state; other sections rendered collapsed while something is focused (purely render-side, `collapsed` flags untouched).
6. Section menu: **Open all** (for each dormant group: `openGroup(id)` with that group's own behaviour; `'tab'` mode now splits when the active pane is owned, so this never merges) and **Close all** (`closeGroup` for each live group; lists intact).
7. Tests: `isEffectivelyHidden` truth table (group/section/focus combinations); plan filing under focus.

Acceptance: focusing a section hides every pane outside it and shows all of its live panes; unfocus restores each group's own hidden state exactly; a note opened by hand while focused appears in the focused section; opening a root group while focused clears focus; Open all / Close all never merge.

## Validation

- `npm test` (Vitest) for `membership.ts` and store-level undo; `npm run build` (tsc + esbuild) and `npm run lint`.
- Manual matrix in Obsidian (dev vault): README Features list end-to-end; native tab drag between panes; close anchor tab; close split; restart with 3 panes; Terminus or Web Viewer tab (non-file keys) in a group through merge/undo; focus + open note by hand; hide section while focused.
- Watch for pane `id` instability: if a split/drag causes a pane id to change, the group must go dormant and reattach via D7 on the same pass (test with a fixture where the pane id changes but contents match).

## Risks

- `leaf.parent.id` is undocumented (same class of reliance as `leaf.id`). Isolate the read in one helper (`getPaneId`) so a rename is a one-line fix; fall back to dormant + reattach if absent.
- D1 moves records between live groups silently on native drags; that is intended, but a user dragging a tab *out* of a focused section's pane into a hidden pane will not see it - acceptable, consistent with Obsidian.
- Undo after the target pane was closed: restore the group as dormant with its records (no leaves to reopen) and say so in the Notice.

## Out of scope / follow-ups

- Candidate C (full Workspace adapter seam with in-memory implementation) - only draw it if `applyPlan` tests are wanted beyond the pure plan.
- Best-overlap reattach (Q7 option b) if dormant duplicates show up in practice.
- Persisted "Merged" bucket (Q9 option b).
- Complete section verb.
- Reducing `TabSpacesView.ts` size (render/DnD/menu split) - unchanged by this PRD except the placement routing in Phase B.
