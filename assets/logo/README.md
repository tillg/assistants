# Logo assets

The mark is **three stacked cards with one marked in accent** — the set of assistants, with the one
currently running picked out. Chosen from the exploration in
[`docs/logo/explorations/`](../../docs/logo/explorations) (variant `4a`).

## Which file to use

| File | Use for |
| --- | --- |
| `mark.svg` | Embedding in HTML/JSX. Ink is `currentColor`, so it inherits the surrounding text colour. |
| `mark-light.svg` / `mark-dark.svg` | Anywhere `currentColor` won't resolve — Markdown, GitHub, email, slides. |
| `lockup-light.svg` / `lockup-dark.svg` | Mark plus wordmark. The default for READMEs and page headers. |
| `wordmark-light.svg` / `wordmark-dark.svg` | Wordmark alone, where the mark already appears nearby. |
| `favicon.svg` | Browser tab. Switches ink and accent by `prefers-color-scheme` on its own. |
| `favicon-16/32/48.png` | Fallback favicons. Transparent background, ink mark. |
| `apple-touch-icon.png` (180) | iOS home screen. Paper ground, full bleed — iOS applies its own rounding. |
| `icon-192.png` / `icon-512.png` | PWA manifest / Android. |
| `lockup-*@2x.png` | Where SVG isn't accepted. 1028×256. |

## Colours

| Token | Light | Dark |
| --- | --- | --- |
| Ink (the cards) | `#171A18` | `#E6E8E1` |
| Accent (the dot) | `#6D5DE3` | `#6D5DE3` |
| Paper (icon ground) | `#E8E9E3` | `#121513` |

The accent is the only colour that carries meaning: it marks the active assistant. Don't recolour the
cards with it.

The accent does **not** flip between themes, and that's deliberate. The dot sits on the front card,
not on the page, so it has to hold against the card — which is near-black in light mode and near-white
in dark mode. `#6D5DE3` clears 3:1 against both. A violet tuned for one ground washes out on the other.

## Rules

- **Clear space**: keep the mark's own card width (23 units of the 64-unit grid) free on every side.
- **Minimum size**: 16 px for the mark, 96 px wide for the lockup. Below that the three cards merge.
- The two back cards are the *same* ink at 22% and 40% opacity — they are not separate greys, so the
  mark composites correctly over any ground.
- Don't outline the cards, add a fourth, reorder the depth, or move the dot off the front card.

## Regenerating

The wordmark in the lockups is outlined SF Mono Semibold, not live text, so it renders identically
everywhere. To rebuild the rasters after editing an SVG:

```sh
cd assets/logo
for s in 16 32 48; do rsvg-convert -w $s -h $s favicon.svg -o favicon-$s.png; done
rsvg-convert -w 1028 -h 256 lockup-light.svg -o lockup-light@2x.png
```
