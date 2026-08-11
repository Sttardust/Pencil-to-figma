# Visual acceptance testing

The bridge includes a deterministic PNG comparison command for validating the same screen rendered
by Pencil and Figma. It combines two signals:

- anti-alias-aware pixel mismatch catches displaced, resized, missing, or incorrectly stacked
  elements;
- mean absolute color error catches broad, lower-contrast changes such as a reversed scrim or
  altered image treatment.

For a linked screen, the normal user workflow is simpler: select the complete Figma screen and
choose **Compare Pencil and Figma**. The plugin captures both renders at 2×, shows the match
percentage, and offers a highlighted difference image. The manual command below remains available
for maintainers who need persistent release reports and golden fixtures.

## Capture a comparison pair

Export the complete root frame from both applications as PNG at the same scale. Use 2× for the
acceptance set and make sure both exports have identical pixel dimensions. Compare exported nodes,
not screenshots of the editor canvas, because canvas labels, selection outlines, and backgrounds
are application UI rather than part of the design.

Use these filenames for a repeatable case:

```text
fixtures/renders/<case>/pencil.png
fixtures/renders/<case>/figma.png
```

Large render files and generated results do not need to be committed unless they are approved
goldens for the release suite.

## Run the comparison

```sh
npm run visual:compare -- \
  fixtures/renders/e20-info-3/pencil.png \
  fixtures/renders/e20-info-3/figma.png \
  --diff artifacts/visual/e20-info-3.diff.png \
  --report artifacts/visual/e20-info-3.json
```

The command exits with:

- `0` when both thresholds pass;
- `1` when the images are valid but materially different;
- `2` for invalid arguments, unreadable PNGs, or different dimensions.

Default thresholds are:

| Signal                    | Default |
| ------------------------- | ------- |
| Per-pixel color threshold | `0.10`  |
| Maximum mismatched pixels | `2%`    |
| Maximum mean color error  | `1.5%`  |

Do not loosen a threshold to make a regression pass. First inspect the highlighted diff PNG and
the bridge's structural verification details. Change a threshold only when several known-correct
exports demonstrate a consistent renderer-specific difference.

## Release acceptance set

At minimum, compare these cases in both transfer directions:

1. a simple text and solid-fill screen;
2. an image-heavy screen with status-bar icons;
3. the E20 information screen with the bottom scrim gradient;
4. a component instance with text overrides;
5. a screen using variables and a substituted font;
6. a four-screen batch to confirm equal top alignment and independent root bounds.

For each case, retain the JSON report with the release artifacts. A public beta is ready only when
all approved cases pass at 2× and the structural read-back checks also succeed.
