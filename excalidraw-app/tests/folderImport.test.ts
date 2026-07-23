import { get } from "idb-keyval";
import { vi } from "vitest";

import { appJotaiStore } from "../app-jotai";
import { planFromEntries } from "../scenes/archive";
import {
  folderEntriesToArchive,
  mergeCollectionsByName,
  scanFolderForScenes,
} from "../scenes/folderImport";
import {
  disableFolderSync,
  enableFolderSync,
  folderSyncImportErrorAtom,
  folderSyncStatusAtom,
  pendingFolderSyncImportAtom,
} from "../scenes/folderSync";
import { setScenesIndex } from "../scenes/state";

import { asRoot, FakeDirectory } from "./helpers/fakeDirectory";

import type { CollectionMeta } from "../scenes/storage";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("scanFolderForScenes", () => {
  it("lists root files and one level of subfolders, ignoring the rest", async () => {
    const root = new FakeDirectory();
    await root.seedFile("Home.excalidraw", "home");
    await root.seedFile("notes.txt", "not a scene");
    await root.seedFile(".hidden.excalidraw", "dot file");
    await root.seedFile("Ideas/Plan.excalidraw", "plan");
    await root.seedFile("Ideas/readme.md", "not a scene");
    await root.seedFile("Ideas/Deep/Nested.excalidraw", "too deep");
    await root.seedFile(".config/Sneaky.excalidraw", "dot folder");

    const entries = await scanFolderForScenes(asRoot(root));

    expect(entries.map((entry) => entry.path)).toEqual([
      "Home.excalidraw",
      "Ideas/Plan.excalidraw",
    ]);
    expect(text(entries[0].bytes)).toBe("home");
    expect(text(entries[1].bytes)).toBe("plan");
  });

  it("matches the extension case-insensitively", async () => {
    const root = new FakeDirectory();
    await root.seedFile("Upper.EXCALIDRAW", "upper");

    const entries = await scanFolderForScenes(asRoot(root));
    expect(entries.map((entry) => entry.path)).toEqual(["Upper.EXCALIDRAW"]);
  });

  it("propagates permission loss", async () => {
    const root = new FakeDirectory();
    // eslint-disable-next-line require-yield
    root.values = async function* () {
      throw new DOMException("denied", "NotAllowedError");
    };

    await expect(scanFolderForScenes(asRoot(root))).rejects.toMatchObject({
      name: "NotAllowedError",
    });
  });
});

describe("folderEntriesToArchive", () => {
  it("synthesizes a manifest and keys the bytes by the new scene ids", () => {
    const bytes = (content: string) => new TextEncoder().encode(content);
    const archive = folderEntriesToArchive([
      { path: "Home.excalidraw", bytes: bytes("home") },
      { path: "Ideas/Plan.excalidraw", bytes: bytes("plan") },
    ]);

    expect(archive.hadManifest).toBe(false);
    expect(
      archive.manifest.scenes.map((scene) => [scene.name, scene.path]),
    ).toEqual([
      ["Home", "Home.excalidraw"],
      ["Plan", "Ideas/Plan.excalidraw"],
    ]);
    expect(
      archive.manifest.collections.map((collection) => collection.name),
    ).toEqual(["Ideas"]);
    expect(archive.manifest.scenes[0].collectionId).toBeNull();
    expect(archive.manifest.scenes[1].collectionId).toBe(
      archive.manifest.collections[0].id,
    );
    for (const scene of archive.manifest.scenes) {
      expect(text(archive.sceneFiles.get(scene.id)!)).toBe(
        scene.name === "Home" ? "home" : "plan",
      );
    }
  });
});

describe("mergeCollectionsByName", () => {
  const existing: CollectionMeta[] = [
    { id: "c-ideas", name: "Ideas", createdAt: 1 },
  ];

  it("retargets scenes of a same-named folder to the existing collection", () => {
    const manifest = planFromEntries([
      "Ideas/Plan.excalidraw",
      "Fresh/Other.excalidraw",
    ]);
    const merged = mergeCollectionsByName(manifest, existing);

    expect(merged.collections.map((collection) => collection.name)).toEqual([
      "Fresh",
    ]);
    const plan = merged.scenes.find((scene) => scene.name === "Plan")!;
    expect(plan.collectionId).toBe("c-ideas");
    const other = merged.scenes.find((scene) => scene.name === "Other")!;
    expect(other.collectionId).toBe(merged.collections[0].id);
  });

  it("matches against the sanitized collection name the mirror writes", () => {
    const manifest = planFromEntries(["AB Ideas/Plan.excalidraw"]);
    const merged = mergeCollectionsByName(manifest, [
      // sanitizeFilename("A/B Ideas") === "AB Ideas" — the folder a
      // previous sync pass would have created for this collection
      { id: "c-slash", name: "A/B Ideas", createdAt: 1 },
    ]);

    expect(merged.collections).toEqual([]);
    expect(merged.scenes[0].collectionId).toBe("c-slash");
  });

  it("returns the manifest unchanged when nothing matches", () => {
    const manifest = planFromEntries(["Fresh/Other.excalidraw"]);
    expect(mergeCollectionsByName(manifest, existing)).toBe(manifest);
  });
});

describe("enableFolderSync folder scan", () => {
  beforeEach(() => {
    localStorage.clear();
    setScenesIndex({
      version: 1,
      activeSceneId: "s1",
      scenes: [{ id: "s1", name: "Home", createdAt: 1, updatedAt: 1 }],
    });
    appJotaiStore.set(pendingFolderSyncImportAtom, null);
    appJotaiStore.set(folderSyncImportErrorAtom, null);
  });

  afterEach(async () => {
    await disableFolderSync();
    delete (window as any).showDirectoryPicker;
  });

  it("activates immediately when the folder is empty", async () => {
    const root = new FakeDirectory("Empty");
    (window as any).showDirectoryPicker = vi
      .fn()
      .mockResolvedValue(asRoot(root));

    await enableFolderSync();

    expect(appJotaiStore.get(folderSyncStatusAtom)).toBe("active");
    expect(appJotaiStore.get(pendingFolderSyncImportAtom)).toBeNull();
    // the first mirror pass ran
    expect(Object.keys(root.snapshot())).toEqual(["Home.excalidraw"]);
    // and the record was persisted
    const { createStore } = await import("idb-keyval");
    const stored = await get(
      "state",
      createStore("folder-sync-db", "folder-sync-store"),
    );
    expect(stored).toMatchObject({ version: 1 });
  });

  it("parks a pending import instead of activating when the folder has scenes", async () => {
    const root = new FakeDirectory("Existing");
    await root.seedFile("Old.excalidraw", "old");
    (window as any).showDirectoryPicker = vi
      .fn()
      .mockResolvedValue(asRoot(root));

    await enableFolderSync();

    expect(appJotaiStore.get(folderSyncStatusAtom)).toBe("off");
    const pending = appJotaiStore.get(pendingFolderSyncImportAtom);
    expect(pending).not.toBeNull();
    expect(pending!.archive.manifest.scenes.map((scene) => scene.name)).toEqual(
      ["Old"],
    );
    // nothing was written or persisted while parked
    expect(root.snapshot()).toEqual({ "Old.excalidraw": "old" });
  });

  it("surfaces scan failures without enabling sync", async () => {
    const root = new FakeDirectory("Broken");
    // eslint-disable-next-line require-yield
    root.values = async function* () {
      throw new DOMException("denied", "NotAllowedError");
    };
    (window as any).showDirectoryPicker = vi
      .fn()
      .mockResolvedValue(asRoot(root));

    await enableFolderSync();

    expect(appJotaiStore.get(folderSyncStatusAtom)).toBe("off");
    expect(appJotaiStore.get(folderSyncImportErrorAtom)).toMatch(
      /Couldn't read the selected folder/,
    );
  });
});
