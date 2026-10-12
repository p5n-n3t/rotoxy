# ROTOXY admin shell: wireframes (2026-10-12)

## Candidate A: left rail

```
┌────────┬──────────────────────────────────────────────┐
│ ◎ROTOXY│ Heading · verdict                 [actions] │
│ WORKSP │ ledger ledger ledger ledger ledger ledger    │
│  Pool  │ ┌ wide content ──────────┐ ┌ side ───────┐   │
│ PROVID │ │                        │ │             │   │
│  Accts │ └────────────────────────┘ └─────────────┘   │
│ MODELS │                                              │
│  …     │                                              │
└────────┴──────────────────────────────────────────────┘
```

Weaknesses:
- The rail takes about 220px at 1280px wide.
- On mobile the rail turns into a long horizontal scroller, which the user rejected.
- Five groups plus their labels need vertical scrolling on short laptops.

## Candidate B: grouped top bar (selected)

```
┌───────────────────────────────────────────────────────────────────────┐
│ ◎ ROTOXY      WORKSPACE Pool │ PROVIDERS Accounts │ MODELS & APIS Tools │
│ Token2OAuth   OPERATIONS Supervisor │ PLATFORM Security Diagnostics  [Gateway][Sign out] │
├───────────────────────────────────────────────────────────────────────┤
│ full-width operational canvas (12-col grid, ledger first)            │
```

- **At 1280px:** the bar is one or two rows. Groups wrap as whole units and nothing scrolls sideways.
- **Below 1100px:** the brand and the Gateway/Sign-out actions share row 1, and the groups take row 2.
- **Below 620px (including 390px):** the groups sit in a 2-column grid, each with its label above its links. Every link is visible without scrolling and has a touch target of at least 36px.

Why B was selected:
- It gives the full width to dense tables and the overview ledger.
- It removes the skinny rail.
- It keeps every destination one click away.

## Tokens

The shell reuses the relay-gate palette from `DESIGN.md`.

| Element | Light | Dark |
| --- | --- | --- |
| Paper | `#f5f3ee` | `#0d0f12` |
| Ink | `#16191d` | `#e9e6df` |
| Signal (hub, focus) | `#0f7b6c` | `#4fd1b8` |
| Amber | `#9a540f` | `#f0b25c` |

Typography and controls:
- Nav labels are 11px uppercase mono. Nav links are 13.5px at weight 550.
- The wordmark is mono at weight 700 with 0.14em tracking.
- The active link is ink-filled. Buttons use `white-space:nowrap`, so they neither wrap nor truncate.
- Focus is a 2px ring. Reduced motion disables transitions, and the shell has no looping animation.

## Mark

The mark is a rotor ring with a return arrow, one routed spoke, and a signal-coloured hub. The geometry is newly authored and inspired by the predecessor's ROTOXY name; its `rotoxy-logo.webp` was not copied, and no external image API was used.

Files in `assets/brand/`:
- `rotoxy-mark.svg`
- `rotoxy-wordmark.svg`
- `rotoxy-favicon.svg`

The legacy `logo.svg`, `favicon.svg` and `social-banner.svg` are kept.
