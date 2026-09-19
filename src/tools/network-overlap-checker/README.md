# Network overlap checker

A browser-only planning utility in the Network category at `/network-overlap-checker`.

Enter one explicit IPv4 or IPv6 CIDR per line, optionally followed by `# name`. Blank lines and full-line comments are ignored. Host bits are normalized to the network boundary and clearly marked. Duplicate and containment relationships include original line numbers and the shared range. IPv4 and IPv6 are compared separately, including IPv4-mapped IPv6 addresses.

Input stays in memory; the feature sends no network requests and does not save input in browser storage. Copy a Markdown review or download Markdown/JSON. Exported address counts include all addresses, not only usable hosts.

The limit is 256 non-comment entries and 250,000 characters. All overlapping pairs are counted, but the UI and exports list at most 200; truncation is explicit. Invalid lines remain visible and produce an incomplete review. Overlap is not automatically a routing error: parent-child subnets can be intentional. This utility does not scan or change a network.

## Development

Use the repository's pinned pnpm 9.11.0 and frozen lockfile. Run `pnpm dev`, `pnpm exec vitest run --environment jsdom --threads false`, and `pnpm build`. The focused service suite has 61 tests; the complete unit suite has 199 tests across 34 files. This change was validated on Node 26.7.0; upstream `.nvmrc` specifies 18.18.2. No dependency changes were needed.

Browser checks covered the example (five subnets/four overlaps), adjacent disjoint ranges, invalid input, clearing, clipboard Markdown, downloaded JSON and a 390px mobile viewport. Original upstream license and attribution are retained.
