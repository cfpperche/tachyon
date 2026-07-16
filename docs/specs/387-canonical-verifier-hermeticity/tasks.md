# 387 — canonical verifier hermeticity — tasks

- [x] Declare Product Invariant impact.
- [x] Add tracked clean-clone install/build preparation.
- [x] Make socket fixtures independent of a long verifier `TMPDIR` without changing production guards.
- [x] Persist bounded output tails and timeout/signal metadata.
- [x] Add focused preparation, path-length and diagnostic regressions.
- [x] Run focused tests, typecheck, Product Invariants and full verification on the final candidate.
- [x] Run the isolated-clone reproduction from the committed candidate.

**Dogfood-Opt-Out:** Re-running this proof requires creating a disposable canonical Delivery; the accepted no-waiver `verify_task` record and exact delivery identity are preserved in `notes.md`.

**Visual QA Opt-Out:** No user-visible interface changed.
