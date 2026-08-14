# Stoneward Shardplate — Build Bible

Reference site for a competition Stoneward Radiant Shardplate build. Static HTML, no build step,
hosted on GitHub Pages.

**Live site:** https://annie-elequin.github.io/stoneward-shardplate/

## What's here

| Page | What it covers |
| --- | --- |
| Overview | Recommendation, wearer measurements, layer map |
| Presence | How a 5'7" frame reads as heavy infantry — the cantilever shoulder yoke |
| Coverage | Every body zone, its overlap method and material |
| Joints | ROM, plate recipe, and what covers the gap at full bend |
| Fauld | The scale kilt: PETG scales printed onto organza |
| Materials | Selection rule, Texas thermal substitutions, matrix, shopping list, budget |
| Joinery | Fourteen interfaces — how every part attaches to every other part |
| Build order | Nine blocks, 64 weeks, with checkboxes |
| Crew | Delegatable tasks with jigs and acceptance tests |
| Weight | Per-piece budget and the honest loaded number |
| Logistics | Donning, Texas heat protocol, hydration |
| Do not | Mistakes that cost real time or money |
| Render prompts | Paste-ready Gemini prompts for visualising the design |
| Images | Shared reference gallery |

## Progress checkboxes

The build order page has live checkboxes. Progress is stored in **your own browser** via
`localStorage`, so everyone tracking the build gets their own independent state — nobody
overwrites anyone else.

- **Export progress** downloads a JSON file you can share.
- **Import progress** loads someone else's file.
- **Reset** clears your checkboxes only.

For shared, authoritative task tracking, use Linear. Every step has a **Linear** button that copies
it as an issue, and each block has a "Copy whole block" button that produces a Markdown checklist.

### Linear deep links (optional)

To make the Linear buttons open a pre-filled new-issue form instead of just copying, open the
browser console on the site and run:

```js
localStorage.setItem('shardplate.linear.v1', JSON.stringify({ workspace: 'your-workspace', team: 'ENG' }))
```

`workspace` is the slug in your Linear URL (`linear.app/<workspace>/…`) and `team` is the team key
such as `SHARD`. Copy-to-clipboard works with or without this configured.

## Adding images

1. Drop the file into `images/`.
2. Add an entry to `images/manifest.json`:

```json
[
  {
    "file": "hero-v1.png",
    "group": "Renders",
    "caption": "First hero render — shoulders still too narrow"
  }
]
```

3. Commit and push. Pages redeploys in about a minute.

Images are grouped by the `group` field, in the order the groups first appear in the file —
`Inspiration`, `Renders`, `Work in progress` and so on. `group` is optional; entries without one
fall under "Ungrouped". Clicking an image opens it full size.

Keep files under ~2 MB each so the gallery stays quick on hotel wifi. Write captions that say what
you were looking at rather than what the file is — "shoulders still too narrow, no shadow gap" is
worth something in six months; "render 3" is not.

## Editing content

All content lives in `assets/js/data.js` as plain arrays. Edit there — never in the HTML. The
renderers in `assets/js/app.js` pick up changes automatically.

To add a whole new page: add a `PAGES.yourpage = () => \`...\`` function in `app.js`, then add it to
the `NAV` array below it.

## Running locally

No build step and no dependencies. Because the image gallery uses `fetch`, open it through a local
server rather than double-clicking the file:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Source

Generated from the Shardplate build bible canvas. The engineering decisions — 9.0 lb shell,
no PLA anywhere because of Texas car interiors, scales printed onto organza, the cantilever
shoulder yoke — are explained in context on the site rather than summarised here.
