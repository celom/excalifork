import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import { strToU8, zipSync } from "fflate";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { ARCHIVE_MANIFEST_FILENAME, buildManifest } from "../scenes/archive";
import { getCollections } from "../scenes/collections";
import {
  folderEntriesToArchive,
  mergeCollectionsByName,
} from "../scenes/folderImport";
import { applyArchiveImport, readArchive } from "../scenes/import";
import { pickZipFile } from "../scenes/fileio";
import { buildScenePaths } from "../scenes/serialize";
import {
  ROOT_COLLECTION_ID,
  getScenesIndex,
  openCollectionIdAtom,
  setScenesIndex,
} from "../scenes/state";
import { loadSceneSync } from "../scenes/storage";

import ExcalidrawApp from "../App";

import type { CollectionMeta, SceneMeta } from "../scenes/storage";

vi.mock("../scenes/fileio", () => ({
  downloadBlob: vi.fn(),
  pickZipFile: vi.fn(),
}));

const { h } = window;

/** covers the surface applyStoredScene/loadSceneImages actually use */
const apiShim = () =>
  ({
    resetScene: (h.app as any).resetScene,
    updateScene: h.app.updateScene.bind(h.app),
    getAppState: () => h.state,
    addFiles: (h.app as any).addFiles,
    getSceneElementsIncludingDeleted: (h.app as any)
      .getSceneElementsIncludingDeleted,
  } as unknown as ExcalidrawImperativeAPI);

const sceneMeta = (
  overrides: Partial<SceneMeta> & { id: string },
): SceneMeta => ({
  name: "Untitled",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const sceneFileJSON = (elementId: string) =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [
      API.createElement({
        type: "rectangle",
        id: elementId,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ],
    appState: {},
  });

/** hand-built archive: full control over ids without touching the live index */
const makeArchiveFile = (
  scenes: (SceneMeta & { elementId: string })[],
  collections: CollectionMeta[] = [],
) => {
  const paths = buildScenePaths(scenes, collections);
  const manifest = buildManifest({
    scenes,
    collections,
    scope: "all",
    paths,
  });
  const entries: Record<string, Uint8Array> = {
    [ARCHIVE_MANIFEST_FILENAME]: new Uint8Array(
      strToU8(JSON.stringify(manifest)),
    ),
  };
  for (const scene of scenes) {
    entries[paths.get(scene.id)!] = new Uint8Array(
      strToU8(sceneFileJSON(scene.elementId)),
    );
  }
  return new File([new Uint8Array(zipSync(entries)) as BlobPart], "backup.zip");
};

describe("applyArchiveImport", () => {
  beforeEach(async () => {
    await render(<ExcalidrawApp />);
  });

  it("adds non-conflicting scenes and collections with their original ids", async () => {
    const collection: CollectionMeta = {
      id: "col-import",
      name: "Imported collection",
      createdAt: 1,
    };
    const archive = await readArchive(
      makeArchiveFile(
        [
          {
            ...sceneMeta({ id: "scene-import", name: "From backup" }),
            collectionId: "col-import",
            elementId: "elem-import",
          },
        ],
        [collection],
      ),
    );

    const result = await applyArchiveImport({
      archive,
      resolution: null,
      excalidrawAPI: apiShim(),
    });

    expect(result.importedScenes).toBe(1);
    const index = getScenesIndex();
    const imported = index.scenes.find((scene) => scene.id === "scene-import");
    expect(imported).toMatchObject({
      name: "From backup",
      collectionId: "col-import",
    });
    expect(index.collections).toContainEqual(collection);
    expect(loadSceneSync("scene-import")?.elements[0].id).toBe("elem-import");
  });

  it("keep-both imports conflicting scenes as renamed copies", async () => {
    const index = getScenesIndex();
    const existingId = index.activeSceneId;
    const existingBlob = loadSceneSync(existingId);

    const archive = await readArchive(
      makeArchiveFile([
        {
          ...sceneMeta({ id: existingId, name: "Backup version" }),
          elementId: "elem-copy",
        },
      ]),
    );
    await applyArchiveImport({
      archive,
      resolution: "keep-both",
      excalidrawAPI: apiShim(),
    });

    const after = getScenesIndex();
    const copy = after.scenes.find(
      (scene) => scene.name === "Backup version (imported)",
    );
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe(existingId);
    expect(loadSceneSync(copy!.id)?.elements[0].id).toBe("elem-copy");
    // the original is untouched
    expect(loadSceneSync(existingId)).toEqual(existingBlob);
    expect(after.activeSceneId).toBe(existingId);
  });

  it("overwrite replaces a conflicting scene in place and reloads it when active", async () => {
    const existingId = getScenesIndex().activeSceneId;

    const archive = await readArchive(
      makeArchiveFile([
        {
          ...sceneMeta({ id: existingId, name: "Restored", updatedAt: 99 }),
          elementId: "elem-restored",
        },
      ]),
    );
    await act(async () => {
      await applyArchiveImport({
        archive,
        resolution: "overwrite",
        excalidrawAPI: apiShim(),
      });
    });

    const after = getScenesIndex();
    expect(after.scenes.find((scene) => scene.id === existingId)).toMatchObject(
      { name: "Restored", updatedAt: 99 },
    );
    expect(loadSceneSync(existingId)?.elements[0].id).toBe("elem-restored");
    // the overwritten scene was active — the editor got reloaded
    await waitFor(() => {
      expect(h.elements[0]?.id).toBe("elem-restored");
    });
  });
});

describe("applyArchiveImport replace mode", () => {
  beforeEach(async () => {
    await render(<ExcalidrawApp />);
  });

  it("swaps the whole workspace for the archive", async () => {
    const before = getScenesIndex();
    const oldIds = before.scenes.map((scene) => scene.id);

    const archive = await readArchive(
      makeArchiveFile([
        {
          ...sceneMeta({ id: "scene-r1", name: "First" }),
          elementId: "elem-r1",
        },
        {
          ...sceneMeta({ id: "scene-r2", name: "Second" }),
          elementId: "elem-r2",
        },
      ]),
    );
    await act(async () => {
      const result = await applyArchiveImport({
        archive,
        resolution: null,
        excalidrawAPI: apiShim(),
        mode: "replace",
      });
      expect(result.importedScenes).toBe(2);
    });

    const after = getScenesIndex();
    expect(after.scenes.map((scene) => scene.id)).toEqual([
      "scene-r1",
      "scene-r2",
    ]);
    expect(after.activeSceneId).toBe("scene-r1");
    // the old workspace's blobs are gone
    for (const id of oldIds) {
      expect(loadSceneSync(id)).toBeNull();
    }
    // the editor shows the new active scene
    await waitFor(() => {
      expect(h.elements[0]?.id).toBe("elem-r1");
    });
  });

  it("leaves the workspace untouched when every entry is unreadable", async () => {
    const before = getScenesIndex();
    const activeBlobBefore = loadSceneSync(before.activeSceneId);

    const manifest = buildManifest({
      scenes: [sceneMeta({ id: "scene-bad", name: "Bad" })],
      collections: [],
      scope: "all",
      paths: new Map([["scene-bad", "Bad.excalidraw"]]),
    });
    const zipped = zipSync({
      [ARCHIVE_MANIFEST_FILENAME]: new Uint8Array(
        strToU8(JSON.stringify(manifest)),
      ),
      "Bad.excalidraw": new Uint8Array(strToU8("not an excalidraw file")),
    });
    const archive = await readArchive(
      new File([new Uint8Array(zipped) as BlobPart], "corrupt.zip"),
    );

    const result = await applyArchiveImport({
      archive,
      resolution: null,
      excalidrawAPI: apiShim(),
      mode: "replace",
    });

    expect(result.importedScenes).toBe(0);
    const after = getScenesIndex();
    expect(after.scenes.map((scene) => scene.id).sort()).toEqual(
      before.scenes.map((scene) => scene.id).sort(),
    );
    expect(after.activeSceneId).toBe(before.activeSceneId);
    expect(loadSceneSync(before.activeSceneId)?.elements).toEqual(
      activeBlobBefore?.elements,
    );
  });

  it("append-merge lands folder scenes in the same-named existing collection", async () => {
    act(() => {
      setScenesIndex({
        ...getScenesIndex(),
        collections: [{ id: "c-ideas", name: "Ideas", createdAt: 1 }],
      });
    });

    const archive = folderEntriesToArchive([
      {
        path: "Ideas/Plan.excalidraw",
        bytes: new Uint8Array(strToU8(sceneFileJSON("elem-merge"))),
      },
    ]);
    const manifest = mergeCollectionsByName(
      archive.manifest,
      getCollections(getScenesIndex()),
    );
    await act(async () => {
      const result = await applyArchiveImport({
        archive: { ...archive, manifest },
        resolution: null,
        excalidrawAPI: apiShim(),
      });
      expect(result.importedScenes).toBe(1);
    });

    const after = getScenesIndex();
    const imported = after.scenes.find((scene) => scene.name === "Plan")!;
    expect(imported.collectionId).toBe("c-ideas");
    // no duplicate "Ideas" collection was created
    expect(
      after.collections!.filter((collection) => collection.name === "Ideas"),
    ).toHaveLength(1);
    expect(loadSceneSync(imported.id)?.elements[0].id).toBe("elem-merge");
  });
});

describe("Import archive button", () => {
  it("shows the conflict dialog and cancel leaves everything untouched", async () => {
    await render(<ExcalidrawApp />);
    const before = getScenesIndex();

    const activeBlobBefore = loadSceneSync(before.activeSceneId);
    vi.mocked(pickZipFile).mockResolvedValue(
      makeArchiveFile([
        {
          ...sceneMeta({ id: before.activeSceneId, name: "Cancel candidate" }),
          elementId: "elem-x",
        },
      ]),
    );

    act(() => {
      appJotaiStore.set(openCollectionIdAtom, ROOT_COLLECTION_ID);
    });
    await waitFor(() => {
      expect(document.querySelector(".collection-dashboard")).not.toBeNull();
    });

    const importButton = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".collection-dashboard__button",
      ),
    ].find((button) => button.textContent?.includes("Import archive"))!;
    expect(importButton).toBeDefined();
    fireEvent.click(importButton);

    await waitFor(() => {
      expect(document.querySelector(".archive-conflict-dialog")).not.toBeNull();
    });

    const cancelButton = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".archive-conflict-dialog button",
      ),
    ].find((button) => button.textContent?.includes("Cancel"))!;
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(document.querySelector(".archive-conflict-dialog")).toBeNull();
    });
    // nothing imported: same scene set, no rename, scene content not
    // replaced by the archive's (the app's own debounced save keeps
    // rewriting appState, so only elements are stable to compare)
    const after = getScenesIndex();
    expect(after.scenes.map((scene) => scene.id).sort()).toEqual(
      before.scenes.map((scene) => scene.id).sort(),
    );
    expect(
      after.scenes.some((scene) => scene.name.includes("Cancel candidate")),
    ).toBe(false);
    expect(loadSceneSync(before.activeSceneId)?.elements).toEqual(
      activeBlobBefore?.elements,
    );
  });
});
