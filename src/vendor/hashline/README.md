# hashline core (vendored)

Source: `@deathbeam/pi-hashline@0.0.12` (MIT, Tomas Slusny), `src/hashline/{hash,format,parse,apply}.ts`.
Those files were themselves adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi). License: `./LICENSE`.

Changes against upstream:

- TypeScript types stripped (tsc, ES2022), imports renamed to `.mjs`.
- `xxhashjs` replaced with a local `xxh32` (hash.mjs); output verified identical to `XXH.h32(0)` on random UTF-8 input.
- `isRecord` and `throwIfAborted` inlined (they lived in host-specific files).
- Nothing here depends on pi-coding-agent or pi-tui. The Weft tools using it are in `src/kernel/hashline-tools.mjs`.

Not vendored: upstream `read.ts`, `edit.ts`, `grep.ts` (host extension API), read snapshots, three-way merge.
