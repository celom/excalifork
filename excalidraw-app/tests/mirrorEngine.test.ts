/**
 * The reconcile loop both scene mirrors run on (scenes/mirrorEngine.ts).
 *
 * Coalescing is the reason this is shared code rather than duplicated: a pass
 * awaits slow I/O while further index changes land, and two passes running at
 * once would interleave writes for the same scene.
 */

import { createMirrorEngine } from "../scenes/mirrorEngine";
import { setScenesIndex } from "../scenes/state";

import type { ScenesIndex } from "../scenes/storage";

const fixtureIndex = (name = "Home"): ScenesIndex => ({
  version: 1,
  activeSceneId: "s1",
  scenes: [{ id: "s1", name, createdAt: 1, updatedAt: 1 }],
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  localStorage.clear();
  setScenesIndex(fixtureIndex());
});

describe("createMirrorEngine", () => {
  it("never runs two passes at once", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const gate = deferred();

    const engine = createMirrorEngine({
      debounceTimeout: 0,
      onError: () => {},
      pass: async () => {
        maxConcurrent = Math.max(maxConcurrent, ++concurrent);
        await gate.promise;
        concurrent--;
      },
    });

    const first = engine.reconcile();
    const second = engine.reconcile();
    gate.resolve();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
  });

  it("re-runs once for changes that land mid-pass, not once per change", async () => {
    let passes = 0;
    const gate = deferred();

    const engine = createMirrorEngine({
      debounceTimeout: 0,
      onError: () => {},
      pass: async () => {
        if (++passes === 1) {
          await gate.promise;
        }
      },
    });

    const running = engine.reconcile();
    // three changes arrive while the first pass is blocked; they collapse
    // into a single follow-up, which observes the freshest index
    engine.reconcile();
    engine.reconcile();
    engine.reconcile();
    gate.resolve();
    await running;

    expect(passes).toBe(2);
  });

  it("reports failures without wedging the loop", async () => {
    const onError = vi.fn();
    const onSettled = vi.fn();
    let shouldThrow = true;

    const engine = createMirrorEngine({
      debounceTimeout: 0,
      onError,
      onSettled,
      pass: async () => {
        if (shouldThrow) {
          throw new Error("disk on fire");
        }
      },
    });

    await engine.reconcile();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();

    // a failed pass must not leave `running` stuck true, or the mirror is
    // dead for the rest of the session
    shouldThrow = false;
    await engine.reconcile();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("follows index changes only between start and stop", async () => {
    let passes = 0;
    const engine = createMirrorEngine({
      debounceTimeout: 0,
      onError: () => {},
      pass: async () => {
        passes++;
      },
    });

    setScenesIndex(fixtureIndex("before start"));
    await vi.waitFor(() => expect(passes).toBe(0));

    engine.start();
    setScenesIndex(fixtureIndex("after start"));
    await vi.waitFor(() => expect(passes).toBe(1));

    engine.stop();
    setScenesIndex(fixtureIndex("after stop"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passes).toBe(1);
  });

  it("does not schedule a pass for writes the pass itself makes", async () => {
    // cloud sync applies pulled metadata through the index. Without muting,
    // every pull would spend a network round-trip discovering it has nothing
    // left to do.
    let passes = 0;
    const engine = createMirrorEngine({
      debounceTimeout: 0,
      onError: () => {},
      pass: async () => {
        passes++;
      },
    });
    engine.start();

    engine.mute(() => setScenesIndex(fixtureIndex("pulled")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passes).toBe(0);

    setScenesIndex(fixtureIndex("user edit"));
    await vi.waitFor(() => expect(passes).toBe(1));
    engine.stop();
  });
});
