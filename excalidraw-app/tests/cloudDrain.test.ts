/**
 * The background payload drain (`scenes/cloudSync.ts`).
 *
 * `cloudMerge.test.ts` covers what a pass decides; this covers what happens
 * after it — the scenes whose metadata arrived without their blob. Three
 * things are worth pinning down, and all three are ways to lose or corrupt a
 * scene rather than merely to sync one slowly:
 *
 * - a payload that fails to write must leave no keys behind, because a
 *   half-written blob under a scene id is indistinguishable from a real one
 * - the storage ceiling must stop the drain, not be re-hit once per scene
 * - opening a scene mid-drain must join that download, not start a second
 */

import { appJotaiStore } from "../app-jotai";
import { STORAGE_KEYS, sceneElementsKey } from "../app_constants";
import {
  cloudSyncDownloadingAtom,
  cloudSyncPendingAtom,
  cloudSyncStatusAtom,
  initCloudSync,
} from "../scenes/cloudSync";
import { materializeScene } from "../scenes/materialize";
import { getScenesIndex, setScenesIndex } from "../scenes/state";

import type { RemoteIndex } from "../scenes/cloudMerge";
import type { ScenesIndex } from "../scenes/storage";

vi.mock("../data/auth", async () => {
  const { atom, appJotaiStore } = await import("../app-jotai");
  const authUserAtom = atom<any>(null);
  return {
    authUserAtom,
    isAuthAvailable: () => true,
    getCurrentUid: () => appJotaiStore.get(authUserAtom)?.uid ?? null,
  };
});

vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}));

vi.mock("../data/cloudStorage", () => ({
  loadRemoteIndex: vi.fn(),
  saveRemoteIndex: vi.fn(),
  subscribeToRemoteIndex: vi.fn(() => () => {}),
  downloadSceneBlob: vi.fn(),
  uploadSceneBlob: vi.fn(async () => undefined),
  deleteSceneBlob: vi.fn(async () => undefined),
  uploadFile: vi.fn(async () => undefined),
  downloadFiles: vi.fn(async () => ({
    loadedFiles: [],
    erroredFiles: new Map(),
  })),
}));

const cloudStorage = await import("../data/cloudStorage");
const idb = await import("idb-keyval");
const { authUserAtom } = await import("../data/auth");

/** the subset of `AuthUser` the sync engine reads — only `uid` is load-bearing */
const USER = { uid: "u1", displayName: null, email: null, photoURL: null };

/** a rectangle, so no image files are referenced and the IDB file store is
 * never reached */
const shape = (id: string) => ({ id, type: "rectangle", isDeleted: false });

const localIndex = (): ScenesIndex => ({
  version: 1,
  activeSceneId: "local",
  scenes: [{ id: "local", name: "Home", createdAt: 1, updatedAt: 1 }],
});

/** two scenes this device has never seen, as another device would have left
 * them: metadata in the index doc, payloads in Storage */
const remoteIndex = (): RemoteIndex => ({
  version: 1,
  scenes: [
    {
      id: "r1",
      name: "Roadmap",
      createdAt: 2,
      updatedAt: 2,
      contentVersion: 1,
    },
    { id: "r2", name: "Notes", createdAt: 3, updatedAt: 3, contentVersion: 2 },
  ],
  collections: [],
  deleted: {},
  updatedAt: 3,
});

let teardown: () => void = () => {};

/**
 * Signs in and lets the first pass — drain included — finish.
 *
 * "active" is the only reliable terminal signal: the engine sets it from
 * `onSettled`, which runs after `pass()` resolves, and the drain is the last
 * thing inside `pass()`. Waiting on the downloading flag instead would return
 * immediately, before the drain had a chance to raise it.
 */
const runSync = async () => {
  teardown = initCloudSync();
  appJotaiStore.set(authUserAtom, USER);
  await vi.waitFor(() =>
    expect(appJotaiStore.get(cloudSyncStatusAtom)).toBe("active"),
  );
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  setScenesIndex(localIndex());
  appJotaiStore.set(authUserAtom, null);

  vi.mocked(cloudStorage.loadRemoteIndex).mockResolvedValue(remoteIndex());
  vi.mocked(cloudStorage.saveRemoteIndex).mockImplementation(
    async (_uid, next) => ({ committed: true, remote: next }),
  );
  vi.mocked(cloudStorage.downloadSceneBlob).mockImplementation(
    async (_uid, id) => ({ elements: [shape(`${id}-a`)] as any, appState: {} }),
  );
});

afterEach(() => {
  teardown();
  appJotaiStore.set(authUserAtom, null);
  // the quota test spies on localStorage itself — leaving that in place would
  // fail every test after it
  vi.restoreAllMocks();
});

describe("payload drain", () => {
  it("downloads every pulled scene without waiting for it to be opened", async () => {
    await runSync();

    expect(vi.mocked(cloudStorage.downloadSceneBlob).mock.calls.length).toBe(2);
    expect(appJotaiStore.get(cloudSyncPendingAtom)).toBe(0);

    for (const id of ["r1", "r2"]) {
      expect(localStorage.getItem(sceneElementsKey(id))).toBeTruthy();
      expect(
        getScenesIndex().scenes.find((scene) => scene.id === id)?.materialized,
      ).toBe(true);
    }
  });

  it("keeps a scene pending when its download fails, and leaves no keys", async () => {
    vi.mocked(cloudStorage.downloadSceneBlob).mockImplementation(
      async (_uid, id) => {
        if (id === "r1") {
          throw new Error("network");
        }
        return { elements: [shape("r2-a")] as any, appState: {} };
      },
    );

    await runSync();

    // one failure must not strand the rest of the list
    expect(appJotaiStore.get(cloudSyncPendingAtom)).toBe(1);
    expect(localStorage.getItem(sceneElementsKey("r2"))).toBeTruthy();
    // the whole point: no blob means the scene stays unopenable rather than
    // opening as empty and replicating that emptiness back over the account
    expect(localStorage.getItem(sceneElementsKey("r1"))).toBeNull();
    expect(
      getScenesIndex().scenes.find((scene) => scene.id === "r1")?.materialized,
    ).toBe(false);
  });

  it("stops at the storage ceiling instead of re-hitting it per scene", async () => {
    // jsdom's localStorage is a Proxy and does not route through
    // `Storage.prototype.setItem`, so the instance is the only spyable seam
    const realSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation(
      (key: string, value: string) => {
        if (key.startsWith(sceneElementsKey(""))) {
          throw new DOMException("full", "QuotaExceededError");
        }
        // the index write itself must keep working — it is what records
        // which scenes did not make it
        realSetItem(key, value);
      },
    );

    await runSync();

    // second scene never attempted: the ceiling is a property of the device,
    // not of the scene that happened to hit it
    expect(vi.mocked(cloudStorage.downloadSceneBlob).mock.calls.length).toBe(1);
    expect(appJotaiStore.get(cloudSyncPendingAtom)).toBe(2);
    expect(localStorage.getItem(sceneElementsKey("r1"))).toBeNull();
  });

  it("joins an in-flight download rather than starting a second one", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(cloudStorage.downloadSceneBlob).mockImplementation(
      async (_uid, id) => {
        await gate;
        return { elements: [shape(`${id}-a`)] as any, appState: {} };
      },
    );

    teardown = initCloudSync();
    appJotaiStore.set(authUserAtom, USER);
    await vi.waitFor(() =>
      expect(appJotaiStore.get(cloudSyncDownloadingAtom)).toBe(true),
    );

    // the user opens the scene the drain is already fetching
    const opened = materializeScene("r1");
    release!();

    expect(await opened).toBe(true);
    await vi.waitFor(() =>
      expect(appJotaiStore.get(cloudSyncDownloadingAtom)).toBe(false),
    );

    // one call per scene, not two for r1 — a second would race the first's
    // write and burn a round trip
    const ids = vi
      .mocked(cloudStorage.downloadSceneBlob)
      .mock.calls.map((call) => call[1]);
    expect(ids.filter((id) => id === "r1").length).toBe(1);
    expect(appJotaiStore.get(cloudSyncPendingAtom)).toBe(0);
  });

  it("persists the materialized flags so a reload does not re-download", async () => {
    await runSync();

    const persisted = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_SCENES_INDEX)!,
    ) as ScenesIndex;

    expect(
      persisted.scenes
        .filter((scene) => scene.id !== "local")
        .every((scene) => scene.materialized === true),
    ).toBe(true);
  });

  /**
   * Collections have no payload, so nothing in the pass writes them to the
   * record the way `pushScene` writes scenes. That left the map permanently
   * empty, and an empty map makes a collection deleted here indistinguishable
   * from one this device has never pulled — so every pass added it straight
   * back and collections could not be deleted at all.
   */
  it("records the collections it published, not only the scenes", async () => {
    const collection = { id: "c", name: "Work", createdAt: 5, updatedAt: 5 };
    setScenesIndex({ ...localIndex(), collections: [collection] });
    vi.mocked(cloudStorage.loadRemoteIndex).mockResolvedValue({
      ...remoteIndex(),
      collections: [collection],
    });

    await runSync();

    const persisted = vi.mocked(idb.set).mock.calls.at(-1)?.[1] as any;
    expect(persisted?.collections).toEqual({ c: 5 });
  });
});
