import { computeSyncOps, syncScenesToFolder } from "../scenes/folderSync";
import { buildScenePaths } from "../scenes/serialize";
import { setScenesIndex } from "../scenes/state";
import { saveSceneSync } from "../scenes/storage";

import { asRoot, FakeDirectory } from "./helpers/fakeDirectory";

import type { SyncedScenes } from "../scenes/folderSync";
import type { CollectionMeta, SceneMeta, ScenesIndex } from "../scenes/storage";

const sceneMeta = (
  overrides: Partial<SceneMeta> & { id: string },
): SceneMeta => ({
  name: "Untitled",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const collectionMeta = (
  overrides: Partial<CollectionMeta> & { id: string },
): CollectionMeta => ({
  name: "Collection",
  createdAt: 1,
  ...overrides,
});

describe("computeSyncOps", () => {
  const paths = (scenes: SceneMeta[], collections: CollectionMeta[] = []) =>
    buildScenePaths(scenes, collections);

  it("writes new scenes", () => {
    const scenes = [sceneMeta({ id: "s1", name: "A" })];
    expect(computeSyncOps({}, scenes, paths(scenes))).toEqual({
      writes: [{ id: "s1", path: "A.excalidraw" }],
      deletes: [],
    });
  });

  it("writes updated scenes and skips unchanged ones", () => {
    const scenes = [
      sceneMeta({ id: "s1", name: "A", updatedAt: 2 }),
      sceneMeta({ id: "s2", name: "B", updatedAt: 1 }),
    ];
    const synced: SyncedScenes = {
      s1: { path: "A.excalidraw", updatedAt: 1 },
      s2: { path: "B.excalidraw", updatedAt: 1 },
    };
    expect(computeSyncOps(synced, scenes, paths(scenes))).toEqual({
      writes: [{ id: "s1", path: "A.excalidraw" }],
      deletes: [],
    });
  });

  it("rewrites at the new path and deletes the old one on rename", () => {
    const scenes = [sceneMeta({ id: "s1", name: "Renamed" })];
    const synced: SyncedScenes = {
      s1: { path: "Old.excalidraw", updatedAt: 1 },
    };
    expect(computeSyncOps(synced, scenes, paths(scenes))).toEqual({
      writes: [{ id: "s1", path: "Renamed.excalidraw" }],
      deletes: [{ path: "Old.excalidraw" }],
    });
  });

  it("moves the file when the scene changes collection", () => {
    const collections = [collectionMeta({ id: "c1", name: "Ideas" })];
    const scenes = [sceneMeta({ id: "s1", name: "A", collectionId: "c1" })];
    const synced: SyncedScenes = { s1: { path: "A.excalidraw", updatedAt: 1 } };
    expect(computeSyncOps(synced, scenes, paths(scenes, collections))).toEqual({
      writes: [{ id: "s1", path: "Ideas/A.excalidraw" }],
      deletes: [{ path: "A.excalidraw" }],
    });
  });

  it("moves contained files when the collection is renamed", () => {
    const collections = [collectionMeta({ id: "c1", name: "Projects" })];
    const scenes = [sceneMeta({ id: "s1", name: "A", collectionId: "c1" })];
    const synced: SyncedScenes = {
      s1: { path: "Ideas/A.excalidraw", updatedAt: 1 },
    };
    expect(computeSyncOps(synced, scenes, paths(scenes, collections))).toEqual({
      writes: [{ id: "s1", path: "Projects/A.excalidraw" }],
      deletes: [{ path: "Ideas/A.excalidraw" }],
    });
  });

  it("deletes files of scenes gone from the index", () => {
    const synced: SyncedScenes = {
      gone: { path: "Gone.excalidraw", updatedAt: 1 },
    };
    expect(computeSyncOps(synced, [], new Map())).toEqual({
      writes: [],
      deletes: [{ path: "Gone.excalidraw" }],
    });
  });
});

describe("syncScenesToFolder", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const seedIndex = (index: ScenesIndex) => {
    setScenesIndex(index);
  };

  it("mirrors scenes into collection folders and tracks progress", async () => {
    seedIndex({
      version: 1,
      activeSceneId: "s1",
      scenes: [
        sceneMeta({ id: "s1", name: "Home", updatedAt: 5 }),
        sceneMeta({ id: "s2", name: "Plan", collectionId: "c1", updatedAt: 7 }),
      ],
      collections: [collectionMeta({ id: "c1", name: "Ideas" })],
    });
    saveSceneSync("s1", {
      elements: [{ id: "e1", type: "rectangle", isDeleted: false } as any],
      appState: {},
    });

    const root = new FakeDirectory();
    const synced: SyncedScenes = {};
    let persistCount = 0;
    await syncScenesToFolder({
      root: asRoot(root),
      synced,
      persist: () => {
        persistCount++;
      },
    });

    const disk = root.snapshot();
    expect(Object.keys(disk).sort()).toEqual([
      "Home.excalidraw",
      "Ideas/Plan.excalidraw",
    ]);
    expect(JSON.parse(disk["Home.excalidraw"]).elements[0].id).toBe("e1");
    expect(synced).toEqual({
      s1: { path: "Home.excalidraw", updatedAt: 5 },
      s2: { path: "Ideas/Plan.excalidraw", updatedAt: 7 },
    });
    // persisted after each write + the final prune pass
    expect(persistCount).toBe(3);
  });

  it("applies renames and deletions, pruning empty folders", async () => {
    const root = new FakeDirectory();
    const synced: SyncedScenes = {
      s1: { path: "Old name.excalidraw", updatedAt: 1 },
      gone: { path: "Ideas/Gone.excalidraw", updatedAt: 1 },
    };
    // seed the disk as a previous pass would have left it
    (
      await (
        await root.getFileHandle("Old name.excalidraw", { create: true })
      ).createWritable()
    ).write("old");
    const ideas = await root.getDirectoryHandle("Ideas", { create: true });
    (
      await (
        await ideas.getFileHandle("Gone.excalidraw", { create: true })
      ).createWritable()
    ).write("gone");

    seedIndex({
      version: 1,
      activeSceneId: "s1",
      scenes: [sceneMeta({ id: "s1", name: "New name", updatedAt: 1 })],
    });

    await syncScenesToFolder({ root: asRoot(root), synced, persist: () => {} });

    expect(Object.keys(root.snapshot()).sort()).toEqual([
      "New name.excalidraw",
    ]);
    // the now-empty "Ideas" folder was pruned
    expect(root.directories.size).toBe(0);
    expect(synced).toEqual({
      s1: { path: "New name.excalidraw", updatedAt: 1 },
    });
  });

  it("propagates write failures (permission loss surfaces to the engine)", async () => {
    seedIndex({
      version: 1,
      activeSceneId: "s1",
      scenes: [sceneMeta({ id: "s1", name: "A" })],
    });
    const root = new FakeDirectory();
    root.getFileHandle = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };

    await expect(
      syncScenesToFolder({ root: asRoot(root), synced: {}, persist: () => {} }),
    ).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
