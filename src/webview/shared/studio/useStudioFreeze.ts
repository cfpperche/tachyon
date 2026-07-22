import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { setStudioFreezeListener, type StudioFreezeBusMessage } from "./studioFreezeBus";

/**
 * t-610705 (SDD 410 Phase D, D0, round-3/4/5 fixes) — the client half of the navigation-transaction
 * FSM (studioHost.ts's module doc has the full design; studioFreezeBus.ts explains why this is
 * bus-driven instead of state/effect-driven). Pure mechanism, no domain knowledge.
 *
 * `frozenRef.current` is the ENFORCEMENT primitive — the caller's own field-update function
 * (e.g. `set()`) MUST check it and no-op while true; that check is synchronous and happens in the
 * SAME callstack as the checkpoint's arrival (studioFreezeBus dispatches synchronously), so no
 * `onInput` event processed AFTER a checkpoint's dispatch can ever mutate fields before the ack
 * reflecting THAT checkpoint has already been computed and sent.
 *
 * ROUND-5 FIX — two INDEPENDENT freeze sources, OR'd, not one shared boolean: round 3/4's first cut
 * had a single `frozen` flag that ANY of the four freeze-bus messages flipped directly — so a stray
 * `studioSaveEnd` (e.g. the host rejecting a stale/defensive save attempt while a NAV CHECKPOINT was
 * separately holding the freeze) would incorrectly clear the checkpoint's freeze too, even though
 * the save was never what froze the client. `navFrozenRef`/`saveFrozenRef` are tracked separately;
 * `frozenRef` (and the `frozen` state) is always their OR, recomputed on every source transition —
 * so releasing ONE source can never release the other. Each is a plain boolean, not a counter — that
 * is only safe because studioHost.ts's own invariants (txnLock spanning the whole nav transaction;
 * save/nav mutual exclusion) guarantee at most ONE in-flight operation per source at a time. If a
 * future change ever allowed overlapping begin/end pairs from the SAME source, the first end would
 * incorrectly clear a still-needed hold — replace with a counter if that invariant ever changes.
 *
 * ROUND-6 FIX — `useLayoutEffect`, not `useEffect`, for listener registration: `useEffect` callbacks
 * are scheduled AFTER the browser paints, leaving a real (if narrow) window after this component
 * mounts where a `studioNavCheckpoint` arriving on the synchronous freeze bus would find no listener
 * registered yet and be silently dropped (recovered only by the host's 3s checkpoint timeout — see
 * studioHost.ts's requestCheckpoint — never a permanent hang, but an avoidable stall).
 * `useLayoutEffect` runs synchronously right after Preact commits the DOM mutation, before paint —
 * registering the listener there closes the window down to "before this component's DOM exists at
 * all," which would require a checkpoint to be dispatched from OUTSIDE any render cycle Preact
 * scheduled, not a realistic path in this codebase's single-threaded render pipeline.
 */
export interface StudioFreezeSnapshot {
  dirty: boolean;
  editRevision: number;
  patch: unknown;
}

export interface UseStudioFreezeOptions {
  post: (msg: unknown) => void;
  getSnapshot: () => StudioFreezeSnapshot;
}

export interface StudioFreezeHandle {
  /** Blocks edits/Save/Cancel — true while EITHER source (nav checkpoint or an in-flight save) is
   *  active; releasing one while the other is still held leaves this true. */
  frozen: boolean;
  /** Save specifically in flight (subset of `frozen`) — drives the "Saving…" label. */
  saving: boolean;
  /** Read this SYNCHRONOUSLY inside every field-update function before applying a change. */
  frozenRef: { readonly current: boolean };
  /** Call from the Save button's onClick — optimistic client-side freeze the INSTANT the user
   *  clicks, before the host's own `studioSaveBegin` echo round-trips back. */
  freezeForSave: () => void;
}

export function useStudioFreeze(opts: UseStudioFreezeOptions): StudioFreezeHandle {
  const [frozen, setFrozen] = useState(false);
  const [saving, setSaving] = useState(false);
  const frozenRef = useRef(false);
  const navFrozenRef = useRef(false);
  const saveFrozenRef = useRef(false);
  const postRef = useRef(opts.post);
  postRef.current = opts.post;
  const getSnapshotRef = useRef(opts.getSnapshot);
  getSnapshotRef.current = opts.getSnapshot;

  const recompute = (): void => {
    const next = navFrozenRef.current || saveFrozenRef.current;
    frozenRef.current = next;
    setFrozen(next);
  };

  useLayoutEffect(() => {
    const onFreezeMsg = (msg: StudioFreezeBusMessage): void => {
      if (msg.type === "studioNavCheckpoint") {
        navFrozenRef.current = true; // synchronous — before anything else in this callback runs
        frozenRef.current = true; // set directly too: recompute() below is correct but this makes
        // the ENFORCEMENT primitive true with zero extra function-call indirection on the hot path
        const snap = getSnapshotRef.current();
        postRef.current({ type: "studioNavCheckpointAck", txnId: msg.txnId, dirty: snap.dirty, editRevision: snap.editRevision, patch: snap.patch });
        setFrozen(true);
      } else if (msg.type === "studioNavAbort") {
        navFrozenRef.current = false;
        recompute();
      } else if (msg.type === "studioSaveBegin") {
        saveFrozenRef.current = true;
        recompute();
        setSaving(true);
      } else if (msg.type === "studioSaveEnd") {
        saveFrozenRef.current = false;
        recompute();
        setSaving(false);
      }
    };
    setStudioFreezeListener(onFreezeMsg);
    return () => setStudioFreezeListener(undefined);
  }, []);

  const freezeForSave = (): void => {
    saveFrozenRef.current = true;
    recompute();
    setSaving(true);
  };

  return { frozen, saving, frozenRef, freezeForSave };
}
