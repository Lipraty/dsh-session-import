# Third-party notices

## Scope of the project MIT license

The root MIT license covers the original plugin code and documentation in this repository. It does not relicense third-party artwork, grant trademark rights, or imply endorsement by DeepSeek, Anthropic, OpenAI, Stencil Labs, Earendil, Anomaly, Z.AI, or the upstream harness authors.

## DeepSeek Harness UI reference

The page proportions and selected stylesheet rules in `lib/client.js` are adapted from the shipped DeepSeek Harness plugin-manager UI. Upstream notice:

- Copyright (c) 2026 DeepSeek
- MIT License; full notice: `lib/icons/dsh-native-ui-MIT.txt`

The native UI primitive components are provided by the user's DSH runtime. Their implementation and DSH runtime code are not bundled here.

## SVG artwork and brands

All upstream SVG files have been retained. Some artwork is also embedded as data URLs in `lib/client.js` so opening the interface does not contact third-party asset servers. This does not change its ownership or licensing.

See [`lib/icons/SOURCES.md`](lib/icons/SOURCES.md) for exact official URLs, pinned commits, modifications/theme treatment, parent-brand versus product-mark distinctions, and unresolved branding conditions.

- **Oh My Pi:** upstream MIT notice in `lib/icons/omp-MIT.txt`.
- **OpenCode:** upstream MIT notice in `lib/icons/opencode-MIT.txt`.
- **Pi:** upstream MIT notice in `lib/icons/pi-MIT.txt`; badge is offered by the official Pi press kit.
- **ZCode / Z.AI:** upstream Apache-2.0 text in `lib/icons/zcode-Apache-2.0.txt`. The retained mark is the shared Z.AI tile used by ZCode itself, not a separately verified ZCode-only mark. Upstream states third-party assets may have independent terms.
- **Claude:** official Claude website favicon. It identifies Claude Code by the parent brand, not a dedicated verified Claude Code mark. No general open-source or redistribution license for this website asset has been established. Anthropic's trademark guidelines require specific permission and prior-approved materials. This repository does not claim that such permission has been obtained.
- **OpenAI:** blossom extracted from the official OpenAI Developers website and used to identify Codex by its parent brand. No dedicated Codex SVG was verified. The Codex repository's Apache-2.0 license does not automatically cover this website asset. Detailed current OpenAI brand terms could not be retrieved during initial research; no blanket permission is claimed.

The SVGs remain separate from the project's MIT grant. Anyone redistributing or publicly deploying the artwork is responsible for checking applicable copyright, branding and trademark permissions. To use neutral artwork instead, remove the respective entry from `BRAND_ICONS` in `lib/client.js`; the client falls back to the host's generic plugin artwork.

## Session data and adapters

This repository contains format adapters, not the upstream harness runtimes, model credentials, user transcripts, converted archives, session databases or extracted DSH native runtime modules. Upstream schema references and commit pins are documentation; they do not imply API stability or permission to distribute other people's session contents.
