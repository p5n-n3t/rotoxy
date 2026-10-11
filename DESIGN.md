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

## Primary admin console (`src/ui.ts`)

The admin console (pool, tools, diagnostics, security, login and gateway landing) now uses the same token set as the supervisor desk. Earlier it had a separate dark-only neon theme with gradients and frosted glass; that theme is retired.

- **Composition.** Hairline rules divide the page instead of floating cards. `.card` is a column on the 12-column grid that ends in a bottom rule, not a raised tile. The navigation bar sits above a single rule. Wide content uses 8 of the 12 columns and summaries use 4. On screens 850px and narrower everything stacks, and the action navigation scrolls sideways rather than wrapping.
- **Type.** Body text uses the system sans font at 15/1.55. Metrics, pills, table headers and labels use the system mono font with tabular figures. The smallest text is 11px uppercase mono labels; body copy is never smaller than 12.5px.
- **Controls.** The primary button is ink-filled and turns signal-coloured on hover. Secondary buttons are outlined. Danger buttons are red on a soft red background. Disabled controls are drawn at 50% opacity with a not-allowed cursor. Focus shows a 2px amber/copper ring with a 2px offset.
- **Mark.** `page()` swaps the legacy `<div class="logo">T2</div>` badge for the inline relay-gate SVG. That badge is also emitted by `html.ts#adminNav` and the login page. Every admin page links the SVG favicon as a data URI.
- **Contrast.** These ratios were checked by calculation. Light theme: muted text on paper 6.1:1, signal 4.65:1, amber 5.2:1. Dark theme: muted 7.9:1, signal 10.2:1.
