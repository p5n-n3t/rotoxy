# Token2OAuth visual system

Token2OAuth's operational UI is a measured control desk: show what the selected project actually reports, preserve unknowns, and make nested ownership easy to inspect. The relay-gate mark represents protected lanes converging on a supervised node. The product name remains **Token2OAuth**; dashboard context may describe the workforce/control desk without renaming the product.

## Tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| Paper | `#f5f3ee` | `#0d0f12` | Main canvas |
| Surface | `#fffdf9` | `#14171b` | Cards and controls |
| Sunk | `#ece8df` | `#0a0c0e` | Rail and recessed details |
| Ink | `#16191d` | `#e9e6df` | Primary text and contrast |
| Muted | `#5d636b` | `#a3a7ad` | Secondary labels |
| Signal | `#0f7b6c` | `#4fd1b8` | Links, focus hierarchy, mark node |
| Amber | `#a85d12` | `#f0b25c` | Caution and incomplete states |
| Red | `#a33a2f` | `#f08a7c` | Error states |

Typography uses the system sans stack for reading and a system monospace stack for timestamps, counts, and compact operational labels. Borders and spacing carry hierarchy; color is not the only status cue. Numeric counts use tabular figures, and absent observations say “Not reported” rather than implying zero.

## Composition and behavior

The desktop composition pairs a compact navigation rail with a wide main canvas. A project snapshot ledger leads into health, expandable provider → account → workspace → worker details, jobs/tasks, measured history, the event timeline, and the durable supervision inbox. Nested disclosure remains native `<details>` so keyboard and assistive-technology behavior comes from the browser. The inbox uses authenticated same-origin requests, bounded JSON reads and text-only DOM rendering; unavailable endpoints remain an explicit empty state. It never starts paid tools automatically.

At widths below 850px the rail becomes a horizontally scrollable top navigation and the two-column dashboard stacks. At 520px the ledger becomes two columns and controls wrap for 390px screens. Light and dark palettes follow `prefers-color-scheme`; focus rings remain visible, and `prefers-reduced-motion` disables transitions and animation. Keep overview values grounded in supplied snapshot records and label their scope. Never visualize a missing count as zero or invent activity to fill space.

## Assets

- `assets/brand/logo.svg` — original relay-gate mark for general use.
- `assets/brand/favicon.svg` — simplified high-contrast mark for small tabs.
- `assets/brand/social-banner.svg` — 1200 × 630 share banner.

The dashboard embeds the original mark as inline SVG to inherit its theme-aware stroke, and uses a compact SVG data favicon. These assets are authored from the same geometry and palette.
