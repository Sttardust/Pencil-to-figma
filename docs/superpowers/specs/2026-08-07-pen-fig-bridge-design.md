# pen-fig-bridge — design

Date: 2026-08-07
Author: Mesfin + Claude
Status: approved, ready for implementation planning

## Problem

Design work happens in two tools with complementary strengths. Pencil generates well from
Claude Code instructions; Figma is fluid for manual editing. Today, moving work between them
is a hand-rolled translation performed from scratch each time — slow, non-deterministic, and
impossible to repeat reliably.

A pilot on 2026-08-07 ported two Orchid screens (`Signup / Email`, `C1 · Ledger`) from Pencil
to Figma at exact fidelity. It worked, but every mapping rule was re-derived by hand. This
project turns that one-off into a repeatable, testable capability in both directions.

## Goal

Bidirectional Pencil ↔ Figma transfer with **true round-trip**: generate in Pencil, hand-edit
in Figma, pull changes back, keep generating — without duplicating screens or silently
destroying edits.

## Research findings (these constrain the architecture)

1. **Figma has no write API.** The REST API is read-only for file content; creating or
   modifying nodes requires the Plugin API, which runs only inside Figma. Confirmed current
   as of 2026. Consequence: a standalone Mac app cannot write to Figma.
2. **The Figma MCP is an OAuth'd claude.ai connector**, not a local server — zero entries in
   `~/.claude.json`. Its auth is bound to the Claude session and cannot be reused by an
   external process.
3. **The Pencil MCP is a local binary**
   (`/Applications/Pen.app/…/mcp-server-darwin-x64 --app desktop`) that drives the _running_
   Pencil desktop app. Locally spawnable, but Pencil must be open.
4. **`setPluginData` is forbidden** by the Figma MCP, so per-node provenance cannot be stamped
   into the Figma file. Identity must live in an external sidecar manifest.
5. **`.pen` files are encrypted** and readable only through the Pencil MCP.

Together: the transfer must run inside an agent session for the Figma half. The durable,
robust artifact is therefore a deterministic translator library, not an application.

## Architecture

A pure TypeScript core plus a thin skill that performs all I/O.

```
pen-fig-bridge/
  packages/core/                  pure functions — no I/O, no MCP, no network
    src/schema/pen.ts             Pencil .pen schema types
    src/schema/fig.ts             Figma node subset types
    src/map/pen2fig.ts            forward mapping
    src/map/fig2pen.ts            reverse mapping
    src/map/rules/                layout · text · fill · stroke · effect · vector · component
    src/emit/figScript.ts         emits pre-chunked Figma Plugin API JS
    src/emit/penScript.ts         emits Pencil `execute` JS
    src/emit/expectations.ts      derives post-conditions to assert after a write
    src/manifest.ts               identity + content hashes
    src/diff.ts                   three-way compare
    src/lossy.ts                  unsupported-construct registry
    test/fixtures/                real screens captured from orchid.pen
  packages/cli/                   optional local CLI (Pencil + manifest only)
  skill/SKILL.md                  the driver
  skill/references/               mapping tables, gotchas, asset pipelines
```

Three entry points carry the system:

```ts
pen2fig(penJson, manifest) -> { script: Chunk[], assets: AssetReq[], warnings: Lossy[] }
fig2pen(figJson, manifest) -> { script: Chunk[], assets: AssetReq[], warnings: Lossy[] }
diff(manifest, penJson, figJson) -> { unchanged, penOnly, figOnly, conflicted }
```

The core must not import Node-only APIs. Transport stays strictly at the edges so a Figma
plugin + local bridge (see Future) can reuse the core unchanged.

## Data flow

### Push (Pencil → Figma)

1. Skill reads the user's Pencil selection via `get_app_state`
2. Per screen: `Get(id, { includePathGeometry: true })` → `penJson`
3. `pen2fig(penJson, manifest)` → chunks, asset requests, warnings
4. Skill resolves assets — icons from upstream packages, images downloaded from source URLs —
   then pushes them via `upload_assets` (per-node `nodeId` + `scaleMode`)
5. Skill executes chunks through `use_figma`
6. Skill asserts the emitted expectations, then screenshots and compares against a 2x
   `export_nodes` PNG of the source
7. Manifest updated

### Pull (Figma → Pencil)

1. Skill runs a core-emitted read script through `use_figma` → `figJson`
2. `fig2pen(figJson, manifest)` → chunks, assets, warnings
3. Skill writes via Pencil `execute`
4. Skill verifies via `get_screenshot` and bounds assertions

Chunks are pre-sized to ≤10 logical operations. `use_figma` is atomic per call, so a failure
rolls back one section rather than a whole screen.

## Manifest

`<name>.pen.bridge.json`, stored beside the `.pen` file.

```jsonc
{
  "version": 1,
  "penFile": "orchid.pen",
  "figmaFileKey": "IFR83nOXN9fn5lqWzEnh7E",
  "screens": {
    "Frbpv": {
      "name": "C1 · Ledger",
      "figmaId": "8:22",
      "lastSync": "2026-08-07T00:00:00Z",
      "direction": "pen->fig",
      "nodes": {
        "uDc62": {
          "figmaId": "8:23",
          "penHash": "a1b2c3",
          "figHash": "d4e5f6",
        },
      },
    },
  },
}
```

`penHash` / `figHash` hash only **authored** properties, so that layout recomputation does not
read as a user edit. Concretely the hash covers: type, name, text content and type styling,
fills, strokes, effects, corner radii, layout mode/gap/padding/alignment, sizing _mode_
(`fit_content` / `fill_container` / fixed), and explicit `x`/`y` for absolutely positioned
nodes. It excludes: generated ids, and computed width/height wherever sizing is
`fit_content` or `fill_container`.

## Conflict handling

Three-way compare of stored hash vs current Pencil vs current Figma:

| Stored vs Pencil | Stored vs Figma | Action                                                        |
| ---------------- | --------------- | ------------------------------------------------------------- |
| same             | same            | skip                                                          |
| differs          | same            | push that node                                                |
| same             | differs         | pull that node                                                |
| differs          | differs         | **stop** — report the diverged nodes per side, change nothing |

On conflict the tool writes nothing and prints a per-node table naming what changed on each
side. Resolution is the user's call; there is no automatic merge in v1.

## Lossy registry

Every unsupported construct is declared centrally and returns a typed warning
`{ nodeId, construct, action }` where action is `rasterize | flatten | split | skip`.
Warnings are always surfaced; degradation is never silent.

**Pencil → Figma**

| Construct                           | Action                                            |
| ----------------------------------- | ------------------------------------------------- |
| `shader` fill, `mesh_gradient` fill | rasterize via `export_nodes` → `upload_assets`    |
| `script` node                       | rasterize (bake generated children)               |
| `icon` node                         | resolve from upstream SVG packages → real vectors |
| `note` / `prompt` / `context`       | port to a side annotation layer as text           |

**Figma → Pencil**

| Construct                                                              | Action                                     |
| ---------------------------------------------------------------------- | ------------------------------------------ |
| Component variants / `COMPONENT_SET`                                   | flatten — one Pencil component per variant |
| Auto-layout wrap, grid layout                                          | expand into explicit row frames            |
| Boolean operations                                                     | flatten to baked path geometry             |
| Per-character text styling                                             | split into multiple text nodes             |
| Masks, constraints, dash patterns, corner smoothing, diamond gradients | skip + warn                                |
| Shared text / effect styles                                            | inline                                     |

## Validated mapping (from the pilot — becomes the test suite)

| Pencil                                          | Figma                                    |
| ----------------------------------------------- | ---------------------------------------- |
| `variables` / `themes`                          | Variable collection + modes              |
| `reusable: true` frame                          | Component                                |
| `ref` + `descendants`                           | Instance + overrides                     |
| `layout` / `gap` / `padding` / `justifyContent` | Auto layout                              |
| `fit_content` / `fill_container`                | HUG / FILL                               |
| `textGrowth: fixed-width`                       | `textAutoResize = "HEIGHT"` + FILL       |
| `strokeWidth: {top,bottom}`                     | `strokeTopWeight` / `strokeBottomWeight` |
| `path` + `viewBox`                              | `createNodeFromSvg`                      |
| gradient fill                                   | `GRADIENT_LINEAR` + `gradientTransform`  |
| negative `gap`                                  | negative `itemSpacing`                   |
| `lineHeight` multiplier                         | `{unit: "PERCENT", value: n*100}`        |
| `letterSpacing` number                          | `{unit: "PIXELS", value: n}`             |

Font weight mapping: `700` → Bold, `600` → SemiBold, `500` → Medium, `400`/`normal` →
Regular, `300` → Light. Note family-dependent style naming — Stack Sans uses `SemiBold`,
Inter uses `Semi Bold`.

## Hard rules (encoded as failures, not guidance)

- **Never componentise by name similarity.** Verify structural identity first. In the Orchid
  file, `Head`, `Goal`, `SecRow` and the list row shared names across 45 screens but were
  structurally different components.
- **Rotation must convert.** Pencil rotates counter-clockwise around a node's top-left corner;
  Figma does not. Wrong conversion is visually subtle and therefore dangerous.
- **Fonts are verified before any write.** Missing families abort the run with a list.
- **Unknown property → hard fail** naming the node id. Never guess a mapping.
- **`enabled: false` nodes are skipped**, not ported.
- **Read per-screen.** Broad `Get` traversals over a large `.pen` time out.

## Testing

- **Golden fixtures** — real screens captured as JSON; snapshot the emitted scripts.
  Seed set: `Signup / Email` (simple), `C1 · Ledger` (images + icons + gradient),
  an Introduction screen (local assets), an N3 screen (different family).
- **Round-trip property test** — `pen2fig` then `fig2pen` returns a structurally equal Pencil
  tree, modulo declared lossy actions. Strongest single correctness signal.
- **Unit tests** per mapping rule, seeded from the pilot's validated table.
- **Live verification** stays in the skill: expectation assertions, then screenshot diff.

## Invocation

- `/pen-fig push [screen|selection]`
- `/pen-fig pull [screen]`
- `/pen-fig status` — drift report across all mapped screens
- `npx pen-fig status` — CLI for the Pencil-side and manifest work that needs no Figma auth

## v1 scope

**In:** frames, groups, text, rectangle/ellipse/polygon/path, components and refs, colour +
gradient + image fills, strokes, effects, auto-layout, variables and themes, icons, images —
in **both** directions, with the lossy registry handling the rest by degrading loudly.
Also in: the core package, the driving skill, and the `status` CLI.

**Out:** automatic conflict merging; continuous/watched sync; Figma plugin packaging;
FigJam and Slides. The CLI covers `status` only — `push` and `pull` need the Figma connector
and therefore run through the skill.

### Implementation sequencing

The scope is one package but should not be built as one step. Suggested order, each stage
independently verifiable:

1. Schema types + fixture capture (no mapping yet)
2. `pen2fig` + `emit/figScript` — push only, no manifest; verify against the two pilot screens
3. Manifest + `expectations` — push becomes idempotent and self-verifying
4. `fig2pen` + `emit/penScript` — pull, still no conflict handling
5. `diff` + conflict reporting — round-trip closes
6. Skill + `status` CLI wrapping it all

## Future

A Figma plugin plus a local bridge server would give native Figma-side writes and one-button
ergonomics without an agent session. It is roughly triple the work and is explicitly deferred,
but the core package is designed so it could be reused unchanged.

## Constraints

- Pencil desktop app must be running for any Pencil-side operation.
- Figma writes require an authenticated Claude session with the Figma connector.
- Node v26.5.0, npm 11.17.0 available locally.
- Repo lives at `/Users/semere/Workfiles/Pencil to figma/`; GitHub deferred.
