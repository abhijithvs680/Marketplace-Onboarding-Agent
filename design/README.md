# Design reference

The four artboards the app implements, exported from the design canvas:

| File | Screen |
|---|---|
| `Welcome.dc.html` | Start / resume an application |
| `Main.dc.html` | The onboarding console — stage rail, conversation, submission panel |
| `Review.dc.html` | Review and submitted states |
| `Mobile.dc.html` | The console at 390×844 |
| `canvas.json` | Frame positions and sizes on the canvas |

These are Design Component files. **They will not render correctly if you open
them directly** — each loads a `support.js` that only the canvas host serves,
so the `<x-dc>` wrapper never upgrades. Read them as the spec: the markup,
inline styles, copy and spacing are what `src/` is built from.

Design tokens, as used in `src/styles.css`:

| Token | Value |
|---|---|
| Typeface | IBM Plex Sans; IBM Plex Mono for references, field labels, URLs |
| Accent | `#0D5B52` (deep teal), hover `#09413A` |
| Ink | `#141A1F`, secondary `#3E474F`, muted `#566069` |
| Surfaces | `#FFFFFF` on `#F5F6F8`; lines `#E1E5E9` / `#EDEFF2` |
| Status | captured `#E7F2EC`/`#1B5E3F` · in progress `#FBF0DB`/`#7A4E00` · needed `#EEF0F3`/`#4E5862` |

Placeholders in the artboards (`[YOUR COMPANY]`, `[REFERENCE NO.]`,
`[PARTNER SUPPORT EMAIL]`) are resolved in the app to Vizru and
support@vizru.com. The sample vendor content is demo copy, not real data.
