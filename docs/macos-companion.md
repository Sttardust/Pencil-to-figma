# macOS companion application

The public Pencil ↔ Figma workflow has two local pieces:

1. The Figma Community plugin provides the interface and reads or writes Figma nodes.
2. **Pencil Figma Bridge.app** talks to Pencil on the same Mac through its local MCP executable.

The companion never listens beyond `127.0.0.1`, and the Figma manifest allows only
`http://localhost:32145`. Opening the companion once registers its background service with the
current macOS account. It will then start at login and reconnect to the Figma plugin automatically.

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
