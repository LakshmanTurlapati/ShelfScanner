---
phase: 01-data-contracts
plan: 01
requirements-completed: [REQ-01, REQ-02, REQ-03]
completed: 2026-11-12
---

# Summary 01-01

New sessions carry `contract: 1` and `still` or `walk`. Writers strip `pin` and `coverId` on unstamped shelves. The first finite pin wins. `coverId` is omitted instead of stored as `undefined`. The profile module uses `shelf-scanner-profile` and deletes only that key.

Verified with `npx vitest run` (141 passed) and `npx tsc --noEmit` on 2026-11-12 before later phases changed the tree.
