# macOS companion application

The public Pencil ↔ Figma workflow has two local pieces:

1. The Figma Community plugin provides the interface and reads or writes Figma nodes.
2. **Pencil Figma Bridge.app** talks to Pencil on the same Mac through its local MCP executable.

The companion never listens beyond `127.0.0.1`, and the Figma manifest allows only
`http://localhost:32145`. Opening the companion once registers its background service with the
current macOS account. It will then start at login and reconnect to the Figma plugin automatically.
Its unauthenticated health response contains only the protocol version, companion version,
capability names, macOS platform, and CPU architecture. The plugin uses that information to explain
whether the companion is missing or needs an update before any design operation begins.
On the first connection, macOS displays an Allow/Cancel message. Choosing **Allow** creates the
private saved connection without asking the user to copy or type a code. The older pairing-code
flow remains collapsed in the plugin as a troubleshooting fallback.

Version 0.1.16 supports detailed appearance-check failures, cross-renderer edge tolerance, correct nested component-instance verification, direct selected-page lookup without scanning large Pencil documents,
multi-screen Figma → Pencil export with grouped placement, corrected
Pencil/Figma gradient direction conversion, post-write Pencil fidelity verification, and automatic
2× appearance verification before a new sync link is saved. A Figma batch is sent as individually verified
screen operations so a failure cannot leave a completed-looking partial screen. Each completed
root becomes the placement anchor for the next screen, keeping the batch together from left to
right. The shared sidecar retains separate root ownership for every screen, while mapped
comparison remains a single-screen action. The Figma plugin also keeps a local list of the 20 most
recent Pencil page names, IDs, and canvas positions.

The plugin shows appearance progress and one result per transferred screen. A screen that differs
materially is not linked as a trusted synchronized copy. Multi-screen transfers can be stopped
after the current screen finishes, preserving the screens that already passed without starting the
remaining screens.

Operation failures use stable public error codes and identify the failed phase. The plugin only
suggests retrying when the operation is safe to repeat, while local filesystem paths are removed
from error details before they leave the companion.

The plugin can also read the current Pencil canvas selection. Selecting one or more top-level pages
in Pencil and choosing **Use Selected Pencil Pages** opens one combined Figma review. Up to 50
selected pages are written and linked separately, subject to the shared 5,000-layer and 64 MiB image
limits.

Figma → Pencil creation is recorded in a private operation journal containing only operation
IDs, bridge IDs, phases, timestamps, and failure codes. If the companion stops during writing,
verification, or manifest commit, the next launch marks the operation interrupted and asks the
user to compare the linked design. A successful comparison clears that recovery notice.

Authenticated HTTP calls use the `x-pen-fig-token` header; tokens in URLs are rejected so they do
not leak into request logs or browser history. CORS access is restricted to Figma and its sandboxed
plugin origin. Non-browser local clients can still use the service for diagnostics, but all design
operations require a valid session. Native approval prompts have a cooldown to prevent repeated
dialog spam, and production logs do not reveal the development pairing code.

## Build the applications

Build the edition matching the current Mac:

```sh
npm run companion:build
```

Build both public editions:

```sh
npm run companion:build -- --arch=all
```

The output is written under `dist/macos/x64` and `dist/macos/arm64`. Each directory contains:

- an architecture-specific `.app` bundle;
- a distributable ZIP archive; and
- a SHA-256 checksum file.

The builder downloads the pinned official Node LTS runtime for each architecture and verifies its
SHA-256 digest before packaging it. The runtime is embedded in the application, so users do not
need Node.js, npm, this repository, or a terminal.

Unsigned development builds use an ad-hoc macOS signature. They are suitable only for local
testing. The Intel build can be fully launched and tested on an Intel Mac. The Apple-silicon build
can be cross-compiled and structurally verified on Intel, but it must also be launched on an actual
Apple-silicon Mac before release.

## Sign and notarize a public release

A public download requires a **Developer ID Application** certificate and Apple notarization.
Store the notarization credentials in the macOS Keychain rather than in this repository:

```sh
xcrun notarytool store-credentials "pencil-figma-bridge" \
  --apple-id "APPLE_ID_EMAIL" \
  --team-id "APPLE_TEAM_ID" \
  --password "APP_SPECIFIC_PASSWORD"
```

Then build, sign, notarize, staple, archive, and checksum both editions:

```sh
APPLE_SIGN_IDENTITY="Developer ID Application: YOUR NAME (TEAM_ID)" \
APPLE_NOTARY_PROFILE="pencil-figma-bridge" \
npm run companion:build -- --arch=all
```

The build fails if a downloaded runtime has the wrong checksum, code signing fails, notarization is
rejected, or the resulting application does not pass strict signature verification.

## Local installation test

For automated testing without the confirmation dialog:

```sh
"dist/macos/x64/Pencil Figma Bridge.app/Contents/MacOS/Pencil Figma Bridge" --quiet
curl http://127.0.0.1:32145/health
```

The expected health response is:

```json
{ "ok": true, "protocol": 1 }
```

To remove the installed login helper while retaining the application itself:

```sh
"dist/macos/x64/Pencil Figma Bridge.app/Contents/MacOS/Pencil Figma Bridge" \
  --uninstall --quiet
```
