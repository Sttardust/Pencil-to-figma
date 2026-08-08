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
  and atomically apply one-sided property edits in either direction. If both editors changed the
  same mapped subtree, choose **Keep Pencil**, **Keep Figma**, or **Cancel**; Cancel performs no
  writes.

Initial Figma → Pencil exports are create-copy operations. Each copy is created behind a
placeholder and removed automatically if a chunk fails. After adoption, mapped property updates
and explicit conflict resolution can update that copy in place; structural conflict resolution is
not enabled yet.

Pencil → Figma imports also resolve local Pencil `ref` dependencies by native identity. Reusable
frames become Figma components and resolvable refs become instances; dependency components are
kept outside the screen's sync manifest. Pencil descendant text overrides become native Figma text
component properties, keeping both the reusable component relationship and the instance-specific
copy editable. Unsupported descendant property types return an explicit warning.

Saved Pencil variables are retained in the bridge document and their current values are inlined
for colors, font families, and corner radii so Figma receives the same appearance. Imports report
this flattening explicitly until native Figma variable binding is enabled. Pencil icons from
Lucide, Material Symbols Rounded, and Phosphor are packaged as SVG assets.

If an authored font is unavailable to Figma, the plugin selects the closest loadable family and
weight (for example, Fraunces falls back to Georgia), reports the substitution, and stores separate
Pencil and Figma baseline hashes so the fallback does not appear as a user edit during sync.

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
