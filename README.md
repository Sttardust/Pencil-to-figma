# Pencil ↔ Figma Bridge

Development prototype for transferring editable design trees between Pen and Figma.

## Prerequisites

- macOS with Pen and Figma Desktop installed
- Node.js 22 or newer
- a `.pen` document open in Pen

## Setup

```sh
npm install
npm run doctor
npm run build
```

`doctor` checks the Pen MCP executable, connects to the open Pen document, and performs a
read-only root-frame query.

## Run the transport prototype

Start the local service:

```sh
npm run dev:service
```

The service listens only on `127.0.0.1:32145` and prints a six-character pairing code. The
Figma development plugin connects through `http://localhost:32145`.

Load the development plugin in Figma Desktop:

1. Open **Plugins → Development → Import plugin from manifest…**.
2. Select `packages/figma-plugin/manifest.json`.
3. Run **Pencil Bridge (Development)**.
4. Enter the pairing code printed by the service.

The development plugin currently supports both directions:

- **Pencil → Figma:** search for a Pencil root, preview the sync, and create or update editable
  Figma nodes while preserving the bridge mapping.
- **Figma → Pencil:** select one Figma frame, preview it, build the chunk plan, then confirm
  **Export copy to Pencil…**. The bridge writes a new editable root beside the source frame and
  stages image assets in a `.pen-fig-assets` folder beside the active `.pen` file.
- **Mapped sync:** adopt an exported Pencil copy, preview changes against the last dual baseline,
  and atomically apply property and structural edits in either direction. Mapped sync preserves
  native identities while creating, deleting, moving, or reordering editable nodes. If both
  editors changed the same mapped subtree, choose **Keep Pencil**, **Keep Figma**, or **Cancel**;
  reorder and delete-versus-edit conflicts are resolved atomically, while Cancel performs no
  writes.

Initial Figma → Pencil exports are create-copy operations. Each copy is created behind a
placeholder and removed automatically if a chunk fails. After adoption, mapped property and
structural updates modify that copy in place. The bridge verifies the resulting tree before it
commits the next manifest revision, including native Pencil IDs created while resolving a
delete-versus-edit conflict.

Pencil → Figma imports also resolve local Pencil `ref` dependencies by native identity. Reusable
frames become Figma components and resolvable refs become instances; dependency components are
kept outside the screen's sync manifest. Pencil descendant text overrides become native Figma text
component properties, keeping both the reusable component relationship and the instance-specific
copy editable. Unsupported descendant property types return an explicit warning.
Mapped sync also preserves those instance text overrides in both directions: Figma component
property edits are translated to native Pencil descendant IDs, and Pencil descendant edits are
applied through the corresponding Figma component property without detaching the instance.

Saved Pencil variables are retained in the bridge document. Direct solid fill, stroke, font-family,
and uniform corner-radius references create or reuse native variables in a local `Pencil Variables`
collection and bind the imported Figma layers to them. Unsupported nested uses, such as gradient
stops and effect colors, still inline the current value with an explicit warning. If a font is
substituted because Figma cannot load it, that font binding is skipped so the visible fallback is
preserved. Pencil icons from Lucide, Material Symbols Rounded, and Phosphor are packaged as SVG
assets.

Supported paint blend modes now transfer in both directions instead of being reset to Normal,
including multiply, screen, overlay, burn/dodge, contrast, and color modes. Figma image Fill and
Fit map directly to Pencil. Figma Crop transforms and Tile settings are retained in the bridge and
when returning to Figma; exports to Pencil use Fill with an explicit warning because Pencil has no
matching crop/tile behavior. Pencil Stretch similarly uses Figma Fill with an explicit warning.

Figma text layers with mixed range styling no longer abort an export. The bridge selects the style
and fill from the range covering the most characters, keeps the complete text editable, and emits
a `FIGMA_MIXED_TEXT_STYLES` flattening warning. Uniform text remains lossless.

Negative auto-layout gaps, individual-side strokes, and four independent frame or rectangle corner
radii transfer in both directions. Figma layer types that only accept one stroke width or one corner
radius use the arithmetic mean and emit a stable flattening warning instead of silently diverging.

If an authored font is unavailable to Figma, the plugin selects the closest loadable family and
weight (for example, Fraunces falls back to Georgia), reports the substitution, and stores separate
Pencil and Figma baseline hashes so the fallback does not appear as a user edit during sync.

The plugin UI groups transfers by direction and reduces each transfer to review and send. Mapped
design comparison uses plain Pencil/Figma change counts and destination-specific update actions.
Technical response JSON, native IDs, adoption, and diagnostic tools are hidden by default under
explicit details panels and remain available for troubleshooting or sharing a test result.

When modifying the plugin, run its watch build in another terminal:

```sh
npm run dev:plugin
```

## Checks

```sh
npm test
npm run typecheck
npm run build
npm run format:check
npm audit
```

## Configuration

| Variable               | Purpose                         | Default                 |
| ---------------------- | ------------------------------- | ----------------------- |
| `PEN_FIG_PORT`         | Local bridge port               | `32145`                 |
| `PEN_FIG_PEN_MCP_PATH` | Override the Pen MCP executable | Pen Desktop bundle path |

The Figma development manifest currently permits only `http://localhost:32145`. If the port is
changed, update its `devAllowedDomains` entry as well.
