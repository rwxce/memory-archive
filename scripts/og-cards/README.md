# Open Graph share cards: assets

Inputs for `scripts/generate-og-cards.mjs` (`pnpm og`), which writes `public/og/{en,ca,es}.png`.
Nothing here ships in the app build.

- `assets/sunset.png`, `assets/blossom.png`: the two photos from the approved design mock
  (an illustration, no real people or chats), cropped and un-rotated from it. The card layout
  places them back at the same angle, so the parts the chat card covers stay covered.
- `fonts/Satoshi-{Medium,Bold,Black}.woff2`: Satoshi by Indian Type Foundry (Fontshare, ITF
  Free Font License). Used only to render the PNGs; the app itself keeps system fonts.

The card copy lives in `STR` in the generator, not in `messages/*.json`: the app never shows it.
After changing a card, bump `OG_VERSION` in `app/og.ts` so link-preview caches fetch it again.
