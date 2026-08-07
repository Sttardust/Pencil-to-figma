# Milestone 1 fixture provenance

Date: 2026-08-08
Source document: `/Users/semere/Workfiles/Tenacious/Orchid/orchid.pen`
Pen schema: 2.15

The four seed fixtures were captured read-only from the live Orchid document through Pen's MCP
`Get` operation. The capture used depth 2 to confirm immediate structure without traversing the
entire 600+ root-node document.

| Fixture             | Pen node                       | Purpose                                                         |
| ------------------- | ------------------------------ | --------------------------------------------------------------- |
| `signup-email.json` | `DEFFF` — Signup / Email       | simple vertical layout and reusable status-bar reference        |
| `c1-ledger.json`    | `Frbpv` — C1 · Ledger          | absolute root layout, gradient overlay, effects, and navigation |
| `introduction.json` | `Reg3K` — v4 · 01 Introduction | local image-oriented composition and layered card cluster       |
| `n3-atelier.json`   | `GPTTm` — N3 · Atelier         | alternate visual family and deeper content hierarchy            |

The Milestone 1 bridge fixtures intentionally contain only their verified root authored
properties. Their source node IDs, names, bounds, layout modes, clipping, and background fills
come from the live capture. Immediate child structure was inspected but is not yet represented
as bridge nodes because computed child bounds belong to the Pen importer work in Milestone 2.
Adding guessed bounds here would weaken the golden fixtures.

`fixtures/pen/provenance.json` records the stable source mapping. Later milestones will expand
the fixtures from the same source IDs through the importer, then freeze the complete normalized
trees and rendered references.
