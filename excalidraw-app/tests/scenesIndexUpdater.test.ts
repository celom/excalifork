/**
 * Phase 0 preconditions for cloud sync (see scenes/storage.ts):
 * the `setScenesIndex` updater form, the `materialized` guard, and the
 * `contentVersion`-keyed search cache.
 */

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";
import { applyStoredScene } from "../scenes/actions";
import { searchScenes } from "../scenes/search";
import { getScenesIndex, setScenesIndex } from "../scenes/state";
import { saveSceneSync } from "../scenes/storage";

import type { ScenesIndex } from "../scenes/storage";

const fixtureIndex = (): ScenesIndex => ({
  version: 1,
  activeSceneId: "s1",
  scenes: [
    { id: "s1", name: "Home", createdAt: 1, updatedAt: 1 },
    { id: "s2", name: "Notes", createdAt: 2, updatedAt: 2 },
  ],
});

beforeEach(() => {
  localStorage.clear();
  setScenesIndex(fixtureIndex());
});

describe("setScenesIndex updater form", () => {
  it("applies against the freshest index, not a stale captured one", () => {
    // the shape every scene action hits: read the index, await something
    // that mutates it, then write. The direct-value form would resurrect
    // the stale copy and lose the concurrent rename.
    const stale = getScenesIndex();

    setScenesIndex({
      ...getScenesIndex(),
      scenes: getScenesIndex().scenes.map((scene) =>
        scene.id === "s2" ? { ...scene, name: "Renamed mid-await" } : scene,
      ),
    });

    setScenesIndex((prev) => ({
      ...prev,
      scenes: [
        ...prev.scenes,
        { id: "s3", name: "Added", createdAt: 3, updatedAt: 3 },
      ],
    }));

    const result = getScenesIndex();
    expect(result.scenes.map((scene) => scene.name)).toEqual([
      "Home",
      "Renamed mid-await",
      "Added",
    ]);
    // proves the guard is meaningful — the stale copy really was different
    expect(stale.scenes).toHaveLength(2);
    expect(stale.scenes[1].name).toBe("Notes");
  });

  it("persists the resolved index, not the updater function", () => {
    // the in-memory atom is NOT sufficient coverage here: jotai's primitive
    // setter resolves a function argument on its own, so the atom looks right
    // even without `setScenesIndex` unwrapping it. What breaks is the
    // write-through — `saveIndexSync` would receive the function and persist
    // garbage, losing the index on the next reload.
    setScenesIndex((prev) => ({ ...prev, activeSceneId: "s2" }));

    const persisted = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_SCENES_INDEX,
    );
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted!)).toMatchObject({
      version: 1,
      activeSceneId: "s2",
    });
  });

  it("still accepts a direct value", () => {
    setScenesIndex({ ...fixtureIndex(), activeSceneId: "s2" });
    expect(getScenesIndex().activeSceneId).toBe("s2");
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_SCENES_INDEX)!,
      ),
    ).toMatchObject({ activeSceneId: "s2" });
  });
});

describe("applyStoredScene materialized guard", () => {
  const fakeAPI = () => {
    const api = {
      resetScene: vi.fn(),
      updateScene: vi.fn(),
      getAppState: vi.fn(() => ({ openSidebar: null, theme: "light" })),
      getSceneElementsIncludingDeleted: vi.fn(() => []),
      addFiles: vi.fn(),
    };
    return api as unknown as ExcalidrawImperativeAPI & typeof api;
  };

  it("refuses to render a scene whose payload has not been downloaded", async () => {
    setScenesIndex((prev) => ({
      ...prev,
      scenes: prev.scenes.map((scene) =>
        scene.id === "s2" ? { ...scene, materialized: false } : scene,
      ),
    }));

    const api = fakeAPI();
    const applied = await applyStoredScene("s2", api);

    expect(applied).toBe(false);
    // the destructive calls are the whole point — an unmaterialized scene
    // must not reach resetScene, or the autosave persists the emptiness
    expect(api.resetScene).not.toHaveBeenCalled();
    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it("renders a scene with no blob normally when it is materialized", async () => {
    // absent `materialized` ≡ true: a newly created scene legitimately has
    // no keys yet and must still load as empty
    const api = fakeAPI();
    const applied = await applyStoredScene("s2", api);

    expect(applied).toBe(true);
    expect(api.resetScene).toHaveBeenCalled();
    expect(api.updateScene).toHaveBeenCalled();
  });
});

describe("search cache keying", () => {
  const textScene = (id: string, text: string) => {
    saveSceneSync(id, {
      elements: [
        {
          id: `${id}-t`,
          type: "text",
          text,
          isDeleted: false,
        } as any,
      ],
      appState: {},
    });
  };

  it("does not re-scan when only updatedAt changes (e.g. a pan)", () => {
    textScene("s1", "alpha");
    setScenesIndex((prev) => ({
      ...prev,
      scenes: prev.scenes.map((scene) =>
        scene.id === "s1" ? { ...scene, contentVersion: 7 } : scene,
      ),
    }));

    expect(searchScenes(getScenesIndex(), "alpha")).toHaveLength(1);

    // rewrite the blob with different text but keep contentVersion: a pan
    // bumps updatedAt only, and the cached texts must survive it
    textScene("s1", "beta");
    setScenesIndex((prev) => ({
      ...prev,
      scenes: prev.scenes.map((scene) =>
        scene.id === "s1" ? { ...scene, updatedAt: 999 } : scene,
      ),
    }));

    expect(searchScenes(getScenesIndex(), "alpha")).toHaveLength(1);
    expect(searchScenes(getScenesIndex(), "beta")).toHaveLength(0);
  });

  it("re-scans when contentVersion changes", () => {
    textScene("s2", "gamma");
    setScenesIndex((prev) => ({
      ...prev,
      scenes: prev.scenes.map((scene) =>
        scene.id === "s2" ? { ...scene, contentVersion: 1 } : scene,
      ),
    }));
    expect(searchScenes(getScenesIndex(), "gamma")).toHaveLength(1);

    textScene("s2", "delta");
    setScenesIndex((prev) => ({
      ...prev,
      scenes: prev.scenes.map((scene) =>
        scene.id === "s2" ? { ...scene, contentVersion: 2 } : scene,
      ),
    }));
    expect(searchScenes(getScenesIndex(), "delta")).toHaveLength(1);
  });
});
