# 429 — Agent profile lifecycle and Studio — notes

_Created 2026-07-22. Append-only by convention._

## Design decisions

- The parent task is a coordination slice. Production implementation is split into four follow-ups because transaction ownership, destructive identity operations, portable interchange and UI each have independent trust boundaries and proof.
- Existing profile migration and Soul transactions are useful measured inputs, but neither is silently generalized: the first follow-up must choose and document one lifecycle transaction protocol.
- Product Invariants: none affected. PI-001 remains unchanged.

## Review evidence

- Independent architecture review: `/home/goat/tachyon/.tachyon/probes/probe-a581e95d-7849-4297-96e3-f3e89088eabc/result.json`.
- The probe reported that it could not independently inspect repository files, so implementation-specific assertions were treated as unverified. Its architectural findings on decomposition, exclusive mutation ownership, authority matrix, CAS, recovery and portable export were retained because they match the inspected local seams.

## Deviations

None.

## Tradeoffs

- This adds scheduling overhead but prevents a single cross-layer change from combining security authority, deletion, portability and UI review.

## Open questions

None at parent scope.
