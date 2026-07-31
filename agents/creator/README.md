# Predex creator agent

The creator polls a pluggable candidate source, asks the Predex backend for an
advisory duplicate check, and either skips the canonical duplicate or creates a
new Arc market through `@predex-pump/agent-sdk`.

It is dry-run by default and does not need a private key in that mode:

```sh
PREDEX_API_URL=http://localhost:3001 pnpm start -- --once
```

Broadcasting requires an explicit opt-in. After exporting
`PREDEX_PRIVATE_KEY` from a runtime secret store:

```sh
pnpm start -- --send
```

`PREDEX_DRY_RUN=false` is the equivalent environment-only opt-in. Seed values
use raw six-decimal USDC units. The built-in `StaticCandidateSource` emits its
deterministic demo list once; another source can implement `CandidateSource`
without changing the loop. Omit `--once` to keep polling.
