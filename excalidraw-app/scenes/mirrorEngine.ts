/**
 * The reconcile loop shared by the scene mirrors (folder sync, cloud sync).
 *
 * Both mirrors have the same shape: the scenes index is the source of truth,
 * every change to it flows through `scenesIndexAtom`, and the mirror runs a
 * debounced, idempotent pass that brings its destination back in line. Only
 * the pass differs — one writes files, the other talks to Firebase.
 *
 * Coalescing is the part worth extracting. A pass awaits slow I/O (disk
 * writes, network round-trips) while further index changes keep landing;
 * running passes concurrently would interleave writes for the same scene. So
 * a change arriving mid-pass sets `dirty` and the loop repeats instead, which
 * also means the pass always observes the freshest index rather than one
 * captured when it was scheduled.
 *
 * `mute` exists because a pass may itself write to the index (cloud sync
 * applies pulled metadata that way). Without it every pull would schedule
 * another pass — harmless, since passes are idempotent, but it would spend a
 * network round-trip to discover there is nothing to do.
 */

import { debounce } from "@excalidraw/common";

import { appJotaiStore } from "../app-jotai";

import { scenesIndexAtom } from "./state";

export type MirrorEngine = {
  /** begin following index changes (idempotent) */
  start: () => void;
  /** stop following, dropping any pending pass */
  stop: () => void;
  /** queue a debounced pass */
  schedule: () => void;
  /** run a pass now, coalescing with any in-flight one */
  reconcile: () => Promise<void>;
  /** run `fn`, suppressing the index-change trigger for writes it makes */
  mute: <T>(fn: () => T) => T;
};

export const createMirrorEngine = ({
  pass,
  onSettled,
  onError,
  debounceTimeout,
}: {
  /** one reconcile pass — must be idempotent and safe to re-run */
  pass: () => Promise<void>;
  /** called once the loop drains with no error */
  onSettled?: () => void;
  onError: (error: any) => void;
  debounceTimeout: number;
}): MirrorEngine => {
  let unsubscribe: (() => void) | null = null;
  let running = false;
  let dirty = false;
  let muted = 0;

  const reconcile = async () => {
    if (running) {
      // a change landed mid-pass — run again when this one finishes
      dirty = true;
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        await pass();
      } while (dirty);
      onSettled?.();
    } catch (error: any) {
      onError(error);
    } finally {
      running = false;
    }
  };

  const schedule = debounce(() => {
    reconcile();
  }, debounceTimeout);

  return {
    start: () => {
      if (!unsubscribe) {
        unsubscribe = appJotaiStore.sub(scenesIndexAtom, () => {
          if (!muted) {
            schedule();
          }
        });
      }
    },
    stop: () => {
      schedule.cancel();
      unsubscribe?.();
      unsubscribe = null;
    },
    schedule,
    reconcile,
    mute: (fn) => {
      muted++;
      try {
        return fn();
      } finally {
        muted--;
      }
    },
  };
};
