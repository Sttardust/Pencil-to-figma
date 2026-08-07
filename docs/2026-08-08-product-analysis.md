# Pencil ↔ Figma Bridge — product and architecture analysis

Date: 2026-08-08
Status: recommended direction

## Executive decision

Build a **Figma plugin backed by a small localhost bridge service**, with the existing pure
TypeScript translator core shared between them. Do not begin with a standalone Mac UI.

The Figma plugin supplies the only supported editable-write surface into a Figma document.
The localhost service talks to Pen through its MCP/CLI interface, stores sync manifests, and
handles assets. A menu-bar Mac app can wrap that service later if background startup and
status controls are worth the packaging cost.

## What was verified locally

- Pen 1.2.3 is installed as `/Applications/Pen.app` (`dev.pencil.desktop`).
- Its local MCP service exposes `get_app_state`, `execute`, `get_screenshot`, `export_nodes`,
  and `export_html`; live reads confirmed the open `orchid.pen` document and schema v2.15.
- Pen listens only on loopback and its bundled MCP process connects to the running desktop
  editor. Current Pen documentation also provides a supported headless CLI using the same
  editor engine.
- Figma Desktop is installed and running. Editable document creation is available through
  the Figma Plugin API; the REST file endpoints are useful for reads but are not the node
  mutation surface.
- Figma plugin manifests support localhost HTTP/WebSocket access, so a plugin can exchange
  bridge documents with a local service without automating either app's interface.
- macOS Accessibility permission is not enabled for the current host. It is unnecessary for
  the recommended design and should not become a product dependency.

## Recommended topology

```text
┌──────────────────────── Figma Desktop ────────────────────────┐
│  Pencil Bridge plugin                                         │
│  selection read/write · preview · conflicts · user approval   │
└──────────────────────────┬─────────────────────────────────────┘
                           │ WebSocket on 127.0.0.1
┌──────────────────────────▼─────────────────────────────────────┐
│  pen-fig-bridge service                                       │
│  translator core · asset cache · manifest · three-way diff    │
└──────────────────────────┬─────────────────────────────────────┘
                           │ supported MCP / Pen CLI
┌──────────────────────────▼─────────────────────────────────────┐
│  Pen desktop or headless editor                               │
│  Get/execute · render/export · save .pen                       │
└────────────────────────────────────────────────────────────────┘
```

## User workflow

The plugin has four primary actions:

1. **Send selection to Pen** — converts the current Figma selection, previews warnings, then
   inserts a new Pen screen or updates its mapped peer.
2. **Bring from Pen** — lists top-level Pen screens and imports the selected screen as
   editable Figma nodes.
3. **Sync changes** — performs a three-way comparison against the last successful sync and
   applies one-sided edits.
4. **Status** — shows unchanged, changed in Pen, changed in Figma, conflicted, and lossy nodes.

No continuous automatic sync in v1. Explicit sync is safer because both editors allow rapid,
structural changes and conflicts need a human choice.

## Transfer contract

Use a neutral bridge document instead of translating directly in UI code:

```ts
interface BridgeDocument {
  version: 1;
  source: { app: "pen" | "figma"; documentId: string };
  root: BridgeNode;
  assets: BridgeAsset[];
  variables: BridgeVariable[];
  warnings: TransferWarning[];
}
```

`BridgeNode` represents geometry, layout, paint, text, effects, components, instances, and
source identity in normalized units. Importers produce this model; exporters consume it.
That separation makes round-trip fixtures possible and prevents either application's API
types from becoming the permanent storage format.

## Identity and conflict safety

Store identity in two places:

- A sidecar `<file>.pen.bridge.json` is authoritative for document mapping, hashes, asset
  references, and last-sync state.
- Figma plugin data stores only a bridge node UUID and schema version when the Plugin API
  permits it. The system must still work if plugin data is stripped or the node is copied.

Hash authored properties only. On sync:

| Pen since baseline | Figma since baseline | Result                              |
| ------------------ | -------------------- | ----------------------------------- |
| unchanged          | unchanged            | skip                                |
| changed            | unchanged            | apply Pen → Figma                   |
| unchanged          | changed              | apply Figma → Pen                   |
| changed            | changed              | stop that subtree and show conflict |

Never silently overwrite a two-sided change. V1 conflict resolution is “keep Pen”, “keep
Figma”, or cancel; property-level merging can follow after telemetry shows the common cases.

## Fidelity policy

Editable constructs map natively: frames, auto layout, basic shapes and SVG paths, text,
solid/gradient/image fills, strokes, common effects, variables, components, and instances.

Unsupported constructs must produce visible typed warnings with one declared action:
`rasterize`, `flatten`, `split`, or `skip`. Examples include Pen shaders/mesh gradients,
Figma boolean networks, per-character typography, masks, layout wrap, and unsupported
gradient types. A completed transfer with warnings is never reported as lossless.

## Local protocol and security

- Bind to `127.0.0.1` only; never `0.0.0.0`.
- Generate a random session secret at service start and require it in the WebSocket handshake.
- Require an explicit user action in the Figma plugin before writes.
- Validate payloads and cap node count, asset size, message size, and traversal depth.
- Store no Figma access token. The plugin operates with the permissions of the open file.
- Prefer Pen's supported CLI/MCP interface over reverse-engineering its private loopback port.
- Use a narrow Figma `networkAccess` declaration for the chosen localhost endpoint.

## Repository shape

```text
packages/
  bridge-schema/       neutral types + runtime validation
  core/                pen↔bridge and figma↔bridge mapping, hashes, diff
  service/             localhost WebSocket, Pen adapter, assets, manifests
  figma-plugin/        plugin controller and UI
  cli/                 status, diagnostics, fixture capture
fixtures/              golden Pen/Figma/bridge trees and rendered references
docs/
```

The existing `docs/superpowers/specs/2026-08-07-pen-fig-bridge-design.md` remains useful for
mapping rules and loss policy, but its conclusion that transfers must run inside an agent
session is superseded by the supported Pen CLI plus Figma-plugin-to-localhost architecture.

## MVP sequence

1. Scaffold schema, core, service, and Figma development plugin.
2. Prove the transport with one rectangle/frame/text screen in each direction.
3. Add authored-property hashes, manifest persistence, and idempotent update-in-place.
4. Implement layout, paint, typography, SVG, and image mapping with golden fixtures.
5. Add components/instances and variables.
6. Add conflict UI, lossy warnings, rendered comparison, and recovery tests.
7. Package the service as a login item or menu-bar app only after the plugin workflow is
   stable.

## Acceptance criteria for v1

- A supported fixture transferred Pen → Figma → Pen is structurally equivalent modulo the
  declared lossy registry.
- Re-running sync creates no duplicates and produces no changes when neither side changed.
- One-sided edits update the existing mapped node.
- Two-sided edits do not write until the user resolves the conflict.
- Missing fonts and unknown properties stop before document mutation.
- Every lossy operation names the affected node and action.
- The service is unreachable from non-loopback interfaces and rejects unauthenticated clients.
