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

The Milestone 0 plugin can read Pen screen summaries, inspect the current Figma selection,
and create/remove a temporary Figma rectangle to verify write permission. It does not transfer
designs yet.

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
