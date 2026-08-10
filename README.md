# Pencil–Figma Bridge

Development prototype for transferring editable design trees between Pencil and Figma.

## Supported platforms

The current release target is macOS only:

- Intel Macs (`x86_64`)
- Apple-silicon Macs (`arm64`)
- Figma Desktop as the primary supported editor

Windows and Linux packaging are intentionally out of scope for this phase. The bridge discovers
the matching Pencil MCP executable from either `/Applications` or `~/Applications`; an explicit
`PEN_FIG_PEN_MCP_PATH` override remains available for nonstandard installations.

The npm development workflow uses a LaunchAgent that starts Node.js from this checkout. Public
distribution instead uses the self-contained macOS companion packaging, which includes its own
runtime and native installer. End users will not be expected to install Node.js, clone this
repository, or run terminal commands. A public download must still be signed with the project's
Apple Developer identity and notarized.

See [docs/macos-companion.md](docs/macos-companion.md) for Intel and Apple-silicon builds, local
installation, signing, and notarization.

## Prerequisites

- an Intel or Apple-silicon Mac with Pencil and Figma Desktop installed
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

The service listens only on `127.0.0.1:32145`. The Figma development plugin connects through
`http://localhost:32145`; the printed six-character code is retained only as a troubleshooting
fallback.

Load the development plugin in Figma Desktop:

1. Open **Plugins → Development → Import plugin from manifest…**.
2. Select `packages/figma-plugin/manifest.json`.
3. Run **Pencil–Figma Bridge**.
4. Approve the macOS connection message. No code needs to be typed.

The development plugin currently supports both directions:

- **Pencil → Figma:** search for a Pencil root, preview the sync, and create or update editable
  Figma nodes while preserving the bridge mapping.
- **Figma → Pencil:** select one or more Figma screens, layers inside those screens, or a Figma
  section containing screens. Review the combined summary, then confirm the transfer. The bridge
  writes each screen as a separate editable root in open canvas space and stages image assets in a
  `.pen-fig-assets` folder beside the active `.pen` file. A batch can contain up to 12 screens,
  5,000 editable layers, and 64 MiB of images.
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

Multi-screen exports process and verify one screen at a time. Completed screens remain valid if a
later screen fails, and the plugin reports exactly how many succeeded. The sidecar manifest keeps
independent mappings for every exported screen instead of replacing the previous screen's link.
Mapped comparison and conflict resolution remain deliberately single-screen operations.
Screens from the same batch are placed together from left to right. The plugin stores the 20 most
recent Pencil destinations and shows their page names, native IDs, and canvas positions under
**Recently sent to Pencil**. That list remains available after reopening the plugin and can be
copied for search or troubleshooting.

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
For Pencil → Figma, **Use Selected Pencil Pages** reads the current top-level page selection
directly from Pencil. One selected page opens immediately for review. Several selected pages are
reviewed together and then created or updated one at a time in separate open Figma canvas space,
with progress and safe partial-failure reporting. A selection can contain up to 50 pages and 5,000
editable layers.
Connection onboarding distinguishes a missing companion, an outdated companion, and Pencil without
an open design. The plugin offers the appropriate download, update, or retry action instead of
showing the same developer error for all three conditions.
Transfer failures also identify whether validation, fonts, assets, comparison, writing,
verification, or persistence failed. Retry guidance appears only for operations that are safe to
repeat, and local filesystem paths are removed from public error details.
After every Pencil → Figma write, the plugin reads the imported tree back from Figma and verifies
fixed dimensions, absolute placement, managed layer order, and gradient direction/stops before it
saves a sync baseline. A mismatch is shown as a user-facing verification error, preventing a
visually incorrect transfer from being recorded as successfully synchronized.
The companion also journals Figma → Pencil creation phases without design content. An interrupted
operation is marked failed on restart, and the plugin asks for a mapped comparison before normal
work continues.

### Automatic connection

The first time the plugin connects, macOS asks the user to allow access. After approval, the Figma
plugin saves a private reconnect credential in `figma.clientStorage`, while the service stores its
matching credential in a user-only file under `~/Library/Application Support/Pencil Figma Bridge`.
Reopening the plugin or restarting the bridge negotiates a fresh session token automatically. Use
**Advanced options → Forget saved connection** to require approval again. A six-character pairing
code remains available inside the collapsed troubleshooting option for development emergencies.

For development use without Codex or a terminal session remaining open, install the optional macOS
LaunchAgent once:

```sh
npm run service:install
```

It starts the loopback-only bridge at login and keeps it available in the background. The plugin
then checks whether Pencil and an active `.pen` document are open. Remove it with
`npm run service:uninstall`.

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

| Variable               | Purpose                            | Default                        |
| ---------------------- | ---------------------------------- | ------------------------------ |
| `PEN_FIG_PORT`         | Local bridge port                  | `32145`                        |
| `PEN_FIG_PEN_MCP_PATH` | Override the Pencil MCP executable | Auto-detected macOS app bundle |

The Figma manifest permits only `http://localhost:32145`, where the installed macOS companion
listens. If the port is changed, update its `allowedDomains` entry as well.

### Local security

The companion accepts network connections only on the Mac's loopback interface. Browser requests
are limited to Figma origins (including Figma's sandboxed plugin origin), and authenticated
requests carry their short-lived session token in a private request header rather than in the URL.
Unrelated websites receive a forbidden response. Repeated native approval requests are throttled
so a page cannot continuously open macOS dialogs. Saved reconnect credentials are stored with
user-only file permissions, hidden from the normal plugin interface, and redacted from optional
technical JSON. Production companion logs do not print the fallback pairing code.
