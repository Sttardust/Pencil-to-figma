# Milestone 0 transport spike

Date: 2026-08-08
Status: automated gates passed; Figma Desktop loading requires one manual development-plugin step

## Versions observed

- macOS host with Pen Desktop 1.2.3
- active Pen document: `/Users/semere/Workfiles/Tenacious/Orchid/orchid.pen`
- Pen document schema reported by the live connector: 2.15
- Node.js 26.5.0
- npm 11.17.0
- `@modelcontextprotocol/sdk` 1.30.x
- Figma Desktop running from `/Applications/Figma.app`

## Pen boundary

The supported stdio executable is:

```text
/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-x64
```

The successful invocation is:

```text
mcp-server-darwin-x64 --app desktop
```

The optional `--agent` flag must not be set to an invented agent name. Doing so allowed MCP
initialization but caused tool requests to time out. Omitting the flag matches Pen's own CLI
configuration and successfully completed `get_app_state` and read-only `execute` calls.

The adapter uses the MCP SDK's `StdioClientTransport`; it does not open or reverse-engineer
`~/.pencil/socket/pencil-desktop.sock`. Tool calls have explicit timeouts and the child process
is closed during shutdown.

Observed live result:

```text
✓ Pen MCP connection: orchid.pen
✓ Pen read-only execute: root frames returned
01 · Invite
02 · Verify
03 · Code
```

The query calls `c.skipChildren()` immediately and excludes reusable root frames, preventing a
broad traversal of the 600+ root objects in the pilot document.

## Local service boundary

The service:

- binds to `127.0.0.1`, never all interfaces;
- uses WebSocket with a 1 MiB maximum message size;
- exposes an HTTP `/health` response on the same loopback listener;
- generates a random six-character pairing code, valid for one hour, and a UUID session
  token per start;
- validates every client message with Zod;
- rejects commands before pairing/authentication.

A real local client completed this sequence against the running service:

```text
pair → paired → hello → ready(orchid.pen) → list-pen-screens → pen-screens
```

## Figma boundary

The development plugin contains:

- a dynamic-page manifest;
- development network permission limited to `http://localhost:32145`;
- pairing UI and authenticated handshake;
- current-selection read test;
- reversible write test that creates and immediately removes a 16×16 rectangle.

The controller and UI bundles compile successfully. Installing a development plugin into Figma
Desktop requires a user menu action. macOS Accessibility permission is intentionally not a
runtime dependency, so this repository does not automate that menu with screen control.

Manual gate:

1. start `npm run dev:service`;
2. import `packages/figma-plugin/manifest.json` in Figma;
3. enter the displayed pairing code;
4. confirm the UI reports the active `.pen` file;
5. run selection and reversible-write tests.

## Failure modes established

| Failure                     | Behavior                                             |
| --------------------------- | ---------------------------------------------------- |
| Pen closed                  | `doctor`/service returns a connection error          |
| Pen request stalls          | MCP request times out rather than hanging forever    |
| Wrong pairing code          | `AUTH_PAIRING`; no token issued                      |
| Invalid token               | `AUTH_TOKEN`; no Pen operations allowed              |
| Command before auth         | `AUTH_REQUIRED`                                      |
| Invalid JSON/schema         | `SCHEMA_JSON` or `SCHEMA_MESSAGE`                    |
| Oversized WebSocket message | connection rejected by the WebSocket server          |
| Port unavailable            | service startup fails before printing a pairing code |

## Commands verified

```sh
npm run doctor
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

No application document is mutated by the automated Milestone 0 checks.
