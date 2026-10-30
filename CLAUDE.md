# zimra-fdms

Open-source (MIT) TypeScript SDK for ZIMRA's Fiscalisation Data Management System, published to npm as `zimra-fdms`. Correctness beats speed: a wrong receipt is a compliance failure for whoever ships it.

## Commands

- `npm test` builds, runs `lint:core`, then the node test runner over `test/*.test.ts`
- `npm run typecheck`
- `npm run lint:core` checks that `src/core` stays platform-free
- `npm run spec:drift` compares against the FDMS spec
- `npm run vectors` regenerates test vectors (only when a change is meant to move them)
- `npm run test:e2e` hits ZIMRA's live test environment and needs device credentials, which cloud sessions do not have. Do not run it there.

## Rules

- `src/core` has no platform imports. Node, React Native and browser code live in adapters (`src/node`, `packages/react-native`).
- Money is integer cents. No float multiplies in tax or totals.
- Work from `docs/HARDENING.md`: one item per PR, ideally under ~300 lines, with a test that fails before and passes after. Tick the item in the same PR.
- Keep commercial products (hosted gateways, billing, paid services) out of this repo.
- Never commit certificates, keys or anything matched by `.gitignore` under credentials.
