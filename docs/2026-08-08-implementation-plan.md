# Pencil ↔ Figma Bridge — implementation plan

Date: 2026-08-08
Status: ready for execution
Architecture: Figma development plugin + localhost bridge service + Pen MCP adapter

## 1. Delivery target

Ship a development-installable Figma plugin and a locally runnable bridge service that can:

1. import one selected top-level Pen screen into the current Figma page as editable nodes;
2. export one selected Figma frame into the open Pen document as editable nodes;
3. rerun either direction without creating duplicates;
4. identify one-sided edits and update the mapped peer;
5. stop on two-sided edits and present a conflict;
6. report every unsupported or degraded construct before applying the transfer.

The first release is a developer MVP. Distribution as a signed menu-bar application and
publication to Figma Community are follow-on work, not prerequisites for validating the core
workflow.

## 2. Scope boundaries

### Included in v1

- Figma Design files and Pen `.pen` documents.
- Frames, groups, text, rectangle, ellipse, polygon, SVG path.
- Horizontal/vertical auto layout, padding, gap, alignment, clipping, and fixed/hug/fill sizing.
- Solid, linear/radial/angular gradient, and image fills.
- Uniform and per-side strokes where both sides support them.
- Blur, background blur, inner shadow, and drop shadow where representable.
- Local components, instances, variables, and Pen themes.
- Explicit push, pull, status, and conflict resolution.
- A sidecar manifest, authored-property hashing, asset cache, warnings, and diagnostics.

### Excluded from v1

- Continuous or watched synchronization.
- Property-level automatic conflict merging.
- FigJam, Figma Slides, Dev Mode annotations, and prototypes/interactions.
- Cross-file Figma components and remote design-system library publication.
- Collaborative multi-user locking.
- Automatic font installation.
- Production signing, notarization, auto-update, or app-store distribution.

## 3. Technical decisions

| Area                   | Decision                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| Workspace              | npm workspaces with TypeScript project references                    |
| Runtime                | Node.js 26 locally; target Node 22-compatible output for portability |
| Schema validation      | Zod at all process and persistence boundaries                        |
| Unit/integration tests | Vitest                                                               |
| Property tests         | fast-check                                                           |
| Plugin build           | esbuild, one controller bundle and one UI bundle                     |
| Plugin UI              | TypeScript + plain DOM/CSS for the MVP                               |
| Local transport        | authenticated WebSocket bound to `127.0.0.1`                         |
| Pen transport          | adapter over the supported local MCP interface                       |
| Figma writes           | Figma Plugin API only                                                |
| IDs                    | UUIDv7 bridge IDs; application-native IDs stored as mappings         |
| Hash                   | deterministic canonical JSON + SHA-256                               |
| Assets                 | content-addressed local cache keyed by SHA-256                       |
| Formatting/lint        | Prettier + ESLint with type-aware rules                              |

The core and schema packages must not import Node APIs, Figma globals, MCP clients, filesystem
code, or networking. This keeps them reusable inside both the Figma plugin and service.

## 4. Target repository layout

```text
package.json
package-lock.json
tsconfig.base.json
eslint.config.js
vitest.workspace.ts
packages/
  bridge-schema/
    src/document.ts
    src/node.ts
    src/paint.ts
    src/style.ts
    src/protocol.ts
    src/index.ts
    test/schema.test.ts
  core/
    src/import/pen.ts
    src/import/figma.ts
    src/export/pen.ts
    src/export/figma.ts
    src/map/layout.ts
    src/map/paint.ts
    src/map/text.ts
    src/map/effect.ts
    src/map/component.ts
    src/canonicalize.ts
    src/hash.ts
    src/diff.ts
    src/lossy.ts
    src/index.ts
    test/
  service/
    src/main.ts
    src/config.ts
    src/server.ts
    src/session.ts
    src/pen/adapter.ts
    src/pen/mcp-client.ts
    src/manifest/repository.ts
    src/assets/repository.ts
    src/operations/push.ts
    src/operations/pull.ts
    src/operations/status.ts
    test/
  figma-plugin/
    manifest.json
    src/code.ts
    src/figma/read.ts
    src/figma/write.ts
    src/figma/fonts.ts
    src/figma/plugin-data.ts
    src/ui/index.html
    src/ui/main.ts
    src/ui/styles.css
    test/
  cli/
    src/main.ts
    src/commands/doctor.ts
    src/commands/status.ts
fixtures/
  pen/
  figma/
  bridge/
  renders/
docs/
```

## 5. Protocol outline

The service owns synchronization orchestration. The plugin owns Figma reads and writes.

```ts
type PluginRequest =
  | { type: "hello"; protocol: 1; token: string }
  | { type: "list-pen-screens"; requestId: string }
  | { type: "import-from-pen"; requestId: string; penNodeId: string }
  | { type: "export-to-pen"; requestId: string; figma: BridgeDocument }
  | { type: "status"; requestId: string; figma: BridgeDocument }
  | {
      type: "resolve-conflict";
      requestId: string;
      resolution: ConflictResolution;
    };

type ServiceResponse =
  | { type: "ready"; protocol: 1; penFile?: string }
  | {
      type: "progress";
      requestId: string;
      phase: string;
      completed: number;
      total: number;
    }
  | {
      type: "preview";
      requestId: string;
      document: BridgeDocument;
      warnings: Warning[];
    }
  | {
      type: "apply-figma";
      requestId: string;
      document: BridgeDocument;
      mapping: MappingSeed;
    }
  | { type: "completed"; requestId: string; result: SyncResult }
  | { type: "failed"; requestId: string; error: PublicError };
```

All messages carry a maximum supported protocol version. Unknown message types and unknown
schema properties fail validation. Transfers have two stages: preview, then explicit apply.
For the development MVP, the service prints a short-lived pairing code that the user enters
once in the plugin UI; the plugin exchanges it for the in-memory session token and retains no
long-lived service credential. This makes authentication explicit without requiring a cloud
account or an insecure unauthenticated bootstrap endpoint.

## 6. Milestones

### Milestone 0 — transport feasibility spike

Goal: prove the two application boundaries before building mapping logic.

Tasks:

- Add a minimal workspace and `doctor` command.
- Resolve the supported Pen MCP executable or CLI from documented installation locations.
- Connect to the running Pen desktop editor through MCP and call `get_app_state`.
- Execute a read-only Pen expression that returns one known root node summary.
- Create a minimal Figma development plugin with `documentAccess: "dynamic-page"`.
- Start a loopback WebSocket service on a fixed development port.
- Pair with the service's short-lived code, then complete authenticated `hello`/`ready`
  exchange.
- Prove a Figma read of the current selection and a reversible test-node creation/removal.
- Write `docs/transport-spike.md` with commands, observed versions, and failure modes.

Files introduced:

- root workspace/configuration files;
- `packages/service/src/pen/*`;
- `packages/service/src/server.ts`;
- `packages/figma-plugin/manifest.json` and minimal controller/UI;
- `packages/cli/src/commands/doctor.ts`.

Gate:

- `npm test` passes;
- `npm run doctor` confirms service, Pen, and schema compatibility;
- the development plugin shows “Connected to orchid.pen” without Accessibility permission;
- no undocumented Pen socket protocol is required.

Stop condition: if supported programmatic MCP connection cannot be established, document the
exact blocker before proceeding. Do not build translators against a guessed transport.

### Milestone 1 — neutral bridge schema and fixtures

Goal: establish the durable transfer contract and real test inputs.

Tasks:

- Define versioned Zod schemas and inferred TypeScript types for document, node, layout,
  geometry, paint, text, effects, components, variables, assets, provenance, and warnings.
- Preserve authored sizing mode separately from computed bounds.
- Model application-specific extras only through typed extension records.
- Define `WarningAction = rasterize | flatten | split | skip`.
- Capture compact fixtures from the pilot screens:
  - `Signup / Email`;
  - `C1 · Ledger`;
  - one local-image Introduction screen;
  - one N3 screen using another font family.
- Normalize volatile IDs in fixture snapshots while retaining relationship integrity.
- Add schema round-trip and invalid-payload tests.

Gate:

- every fixture validates;
- serialize → parse → serialize is byte-stable after canonicalization;
- unknown node types and properties fail with a path-specific error.

### Milestone 2 — Pen importer and Figma writer

Goal: complete the first useful direction, Pen → Figma.

Tasks:

- Read one Pen screen at a time with path geometry and resolved authored properties.
- Convert the Pen tree into `BridgeDocument` without Figma dependencies.
- Implement mappings in this order:
  1. hierarchy, position, bounds, visibility, opacity;
  2. frame/group and clipping;
  3. rectangle, ellipse, polygon, path;
  4. solid fills and uniform strokes;
  5. text and font preflight;
  6. auto layout and sizing modes;
  7. gradients, effects, and images.
- In the plugin, create nodes parent-first and maintain an in-memory bridge-ID map.
- Load every required font before mutating the document.
- Place a new imported root using viewport-centered collision-free positioning.
- Roll back the newly created root if any child write fails.
- Add a preview screen summarizing node count, fonts, assets, and warnings.

Gate:

- the two pilot fixtures import into Figma as editable layers;
- font failure makes zero document changes;
- unsupported shader/mesh-gradient fixtures warn and rasterize as declared;
- structural snapshots match golden Figma fixture trees;
- rendered comparison stays within the agreed image-diff threshold.

### Milestone 3 — manifest, identity, and idempotent Pen → Figma sync

Goal: update existing nodes instead of duplicating imports.

Tasks:

- Define manifest schema v1 and atomic persistence (`temp file → fsync → rename`).
- Add bridge IDs to Figma plugin data on nodes created by the plugin.
- Store the sidecar manifest beside the Pen file.
- Canonicalize and hash authored properties only.
- Match in priority order:
  1. valid Figma plugin bridge ID;
  2. manifest application ID mapping;
  3. explicit user remap;
  4. otherwise unmapped—never infer by similar names.
- Produce minimal create/update/move/delete operation plans.
- Add a dry-run operation summary before apply.
- Commit manifest changes only after Figma confirms successful apply.

Gate:

- importing the same unchanged screen twice performs zero node writes;
- a Pen-only text, paint, layout, and child-order edit updates the existing Figma subtree;
- copied nodes with duplicated plugin data are detected and require remapping;
- interrupted writes leave the previous manifest valid.

### Milestone 4 — Figma reader and Pen writer

Goal: support Figma → Pen for the native v1 subset.

Tasks:

- Read only the selected Figma frame/component subtree.
- Convert Figma nodes, variables, images, SVG geometry, and authored layout settings into the
  neutral bridge model.
- Implement bridge → Pen operation planning with small atomic MCP `execute` calls.
- Insert new Pen root frames using `FindEmptySpace`.
- For updates, preserve mapped IDs when Pen supports in-place mutation.
- Keep a new or modified root `placeholder: true` until all chunks validate, then clear it.
- Verify layout problems through Pen's computed bounds/problem visitor.
- Export a post-write render for comparison.

Gate:

- supported Figma fixtures transfer to editable Pen trees;
- failure in a chunk does not leave a completed-looking partial screen;
- Pen schema errors name the bridge node and source Figma node;
- Figma → Pen → Figma passes structural round-trip tests modulo declared loss.

### Milestone 5 — bidirectional diff and conflict handling

Goal: make round-trip synchronization safe.

Tasks:

- Implement three-way comparison using baseline, current Pen, and current Figma hashes.
- Classify nodes as unchanged, Pen-only, Figma-only, conflicted, added, deleted, or unmapped.
- Treat delete-vs-edit as a conflict.
- Compute conflicts at the smallest independently writable subtree.
- Add plugin conflict UI with “Keep Pen”, “Keep Figma”, and “Cancel”.
- Require confirmation before subtree replacement or deletion.
- Record resolution direction and new baseline only after both sides verify.

Gate:

- all four basic three-way cases have unit and end-to-end tests;
- two-sided changes cause zero writes before resolution;
- cancel preserves both documents and the previous baseline;
- chosen resolution updates both mapping and baseline deterministically.

### Milestone 6 — components, variables, and advanced fidelity

Goal: complete the declared editable v1 surface.

Tasks:

- Map structurally verified Pen reusable frames to Figma components.
- Map Pen refs and descendant overrides to Figma instances and overrides.
- Flatten unsupported component-set/variant behavior with a warning.
- Map Pen theme axes to Figma variable collections and modes.
- Inline or create variables according to provenance and user choice.
- Add per-side strokes, negative gap, nonuniform radii, image scale modes, and blend modes.
- Implement the centralized lossy handlers for every listed unsupported construct.

Gate:

- component fixture edits propagate correctly on both sides where semantics match;
- name similarity alone never creates a component mapping;
- variables retain mode-specific values through a round trip;
- every unsupported fixture returns a stable warning code and action.

### Milestone 7 — hardening and developer release

Goal: make the MVP safe and repeatable for daily use.

Tasks:

- Add payload size, node count, depth, asset size, and operation-count limits.
- Bind only to loopback and authenticate every WebSocket connection.
- Rotate session tokens on service restart.
- Redact local paths and document content from normal logs.
- Add reconnect/backoff and actionable disconnected-state UI.
- Add migration handling for protocol, manifest, and bridge schema versions.
- Test malformed messages, path traversal attempts, asset bombs, and stale mappings.
- Add `npm run dev`, `npm run build`, `npm test`, `npm run doctor`, and plugin import docs.
- Produce a clean-room setup checklist on a second macOS user account if available.

Gate:

- full suite passes from a clean install;
- service is not reachable through a non-loopback interface;
- unauthenticated and oversized requests are rejected;
- a user can install the development plugin and complete both transfer directions from the
  README alone.

## 7. Test strategy

### Unit tests

- each property mapping in both directions;
- rotations and origin conversion;
- font family/weight/style mapping;
- gradient transform conversion;
- canonicalization and authored-property hashing;
- warning classification;
- operation planning and ordering;
- conflict classification.

### Property tests

- canonicalization is idempotent;
- bridge serialization is stable;
- supported Pen → bridge → Pen preserves authored structure;
- supported Figma → bridge → Figma preserves authored structure;
- operation plans never reference a child before its parent is created.

### Integration tests

- service/plugin protocol with a fake plugin client;
- service/Pen adapter with recorded MCP responses, plus opt-in live tests;
- manifest atomicity and migration;
- asset download/cache/deduplication;
- reconnect and request cancellation.

### Live acceptance tests

Use dedicated copies of the four pilot screens. For each:

1. import Pen → Figma;
2. compare tree and 2× render;
3. make one Pen-only edit and sync;
4. make one Figma-only edit and sync;
5. make conflicting edits and verify no-write behavior;
6. resolve each direction;
7. export Figma → Pen and compare again;
8. rerun status and confirm clean state.

Live tests must never target the user's original Orchid document or an irreplaceable Figma
file.

## 8. Error and recovery contract

Every public error includes a stable code, human message, phase, source node when applicable,
and whether retry is safe. Errors fall into:

- `CONNECTION_*` — service, plugin, or Pen unavailable;
- `SCHEMA_*` — incompatible or invalid source;
- `FONT_*` — missing or unsupported font/style;
- `ASSET_*` — unavailable, oversized, or invalid asset;
- `MAPPING_*` — unknown property or unsupported node;
- `CONFLICT_*` — two-sided change or ambiguous identity;
- `WRITE_*` — application write or verification failure;
- `MANIFEST_*` — persistence or migration failure.

The service maintains an operation journal containing IDs and phases, not design content. On
restart it marks incomplete operations failed and requires status reconciliation; it never
blindly resumes document writes.

## 9. Work breakdown and dependency order

```text
M0 transport
  └─ M1 schema + fixtures
       ├─ M2 Pen → Figma
       │    └─ M3 identity + idempotency
       └─ M4 Figma → Pen
            └─ M5 diff + conflicts
                 └─ M6 components + variables
                      └─ M7 hardening + release
```

M2 and the Figma-reader portion of M4 can proceed in parallel only after the bridge schema is
stable. Manifest semantics must be agreed before either direction begins update-in-place
work. Advanced constructs should not start until basic round-trip and conflict safety pass.

## 10. First implementation slice

The first coding slice should be deliberately narrow and end-to-end:

1. initialize npm workspaces and shared TypeScript/test configuration;
2. create a bridge schema for frame, rectangle, and text with solid fills;
3. implement `doctor` and establish the Pen MCP connection;
4. scaffold the Figma development plugin and authenticated WebSocket handshake;
5. list Pen top-level frames in the plugin;
6. import one chosen frame containing only supported primitive nodes;
7. verify the created Figma tree and show a transfer result;
8. add tests and document the exact local run/install commands.

Definition of done for this slice: from a fresh terminal, the developer starts the service,
opens the development plugin, chooses a simple Pen frame, and receives editable Figma frame,
rectangle, and text layers without manual JSON copying.

## 11. Decisions deferred until evidence exists

- Whether the service should later be packaged with Tauri, Swift, or a Node-based menu-bar
  wrapper.
- Whether plugin data can become authoritative enough to reduce sidecar dependence.
- Whether visual comparison should use pixelmatch, SSIM, or a hybrid threshold.
- Whether variable creation should default to inline values or shared collections.
- Whether conflict resolution needs property-level selection.
- Whether a published Figma plugin can use a stable localhost port under final review rules.

These decisions do not block the first end-to-end slice.
