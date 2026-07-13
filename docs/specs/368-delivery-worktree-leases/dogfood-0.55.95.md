# Dogfood 0.55.95 — Delivery worktree leases (mechanism-only)

release: 0.55.95
stage: R1_INTENTIONALLY_INCOMPLETE
initial_actor: mechanismLive05595GrokR1
canonical_worktree: /home/goat/.cache/tachyon/worktrees/b349073a/mechanismLive05595GrokR1
base_head: 61866f5368b2d6a5f526777f1c64872f112e2d9d
mechanism_only_warning: exact root is observed, descendants are not proven

## R1 notes

This record is deliberately incomplete for the controlled live dogfood on t-dc5d94.

The three final acceptance markers are omitted by design to force sequential review/fix:

- (omitted) review_verdict ACCEPT line
- (omitted) same_worktree_reused true line
- (omitted) mechanism_only_limit descendants_unproven line

R1 stops here so a reviewer can produce deterministic FINDINGS and a replacement fixer can complete the evidence in this exact Delivery/worktree.
