/**
 * Archive import: reads a collection archive zip (see archive.ts) and
 * restores it into the workspace with restore-by-id semantics — ids from
 * the manifest are kept, so re-importing a backup of this browser's
 * workspace targets the same scenes/collections. Conflicting ids are
 * resolved by the caller's choice: overwrite in place, or keep both
 * (fresh ids for the imported copies).
 */

import { MIME_TYPES } from "@excalidraw/common";
import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import {
  blobToArrayBuffer,
  loadFromBlob,
} from "@excalidraw/excalidraw/data/blob";
import { strFromU8, unzipSync } from "fflate";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import {
  isQuotaExceededError,
  LocalData,
  localStorageQuotaExceededAtom,
} from "../data/LocalData";

import { applyStoredScene } from "./actions";
import {
  ARCHIVE_MANIFEST_FILENAME,
  detectConflicts,
  parseManifest,
  planFromEntries,
} from "./archive";
import { getCollections } from "./collections";
import { getScenesIndex, setScenesIndex } from "./state";
import { deleteSceneSync, newSceneId, scenesStorage } from "./storage";

import type { ArchiveManifest } from "./archive";
import type {
  CollectionId,
  CollectionMeta,
  SceneId,
  SceneMeta,
} from "./storage";

export type ParsedArchive = {
  /** synthesized via `planFromEntries` when the zip has no usable manifest */
  manifest: ArchiveManifest;
  hadManifest: boolean;
  /** manifest scene id → zip entry bytes */
  sceneFiles: Map<SceneId, Uint8Array>;
};

/** throws a user-presentable Error when the file isn't a readable archive */
export const readArchive = async (file: File): Promise<ParsedArchive> => {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await blobToArrayBuffer(file)));
  } catch (error: any) {
    console.error(error);
    throw new Error("This file is not a readable zip archive.");
  }

  let manifest: ArchiveManifest | null = null;
  if (entries[ARCHIVE_MANIFEST_FILENAME]) {
    try {
      manifest = parseManifest(
        JSON.parse(strFromU8(entries[ARCHIVE_MANIFEST_FILENAME])),
      );
    } catch (error: any) {
      console.error(error);
    }
  }
  const hadManifest = manifest !== null;
  if (!manifest) {
    manifest = planFromEntries(Object.keys(entries));
  }

  const sceneFiles = new Map<SceneId, Uint8Array>();
  // tolerate paths the zip doesn't actually contain (hand-edited archives) —
  // those scenes are dropped from the manifest rather than failing the import
  const scenes = manifest.scenes.filter((scene) => {
    const bytes = entries[scene.path];
    if (bytes) {
      sceneFiles.set(scene.id, bytes);
    }
    return !!bytes;
  });

  if (!scenes.length) {
    throw new Error("This archive contains no .excalidraw scenes.");
  }

  return {
    manifest: { ...manifest, scenes },
    hadManifest,
    sceneFiles,
  };
};

export type ConflictResolution = "overwrite" | "keep-both";

const IMPORTED_SUFFIX = " (imported)";

/**
 * Applies a parsed archive to the workspace.
 *
 * All scene blobs are written first and the index is committed once at the
 * end, so a mid-way failure (quota) never leaves dangling index entries —
 * blobs written for ids the index doesn't know about are cleaned up.
 *
 * `resolution` must be provided when `detectConflicts` reports conflicts
 * (the caller shows the summary dialog); pass null otherwise.
 *
 * `mode: "replace"` swaps the whole workspace for the archive in a single
 * index commit — the old scenes are deleted only after all blobs were
 * written, so a mid-way failure leaves the workspace untouched. Meant for
 * conflict-free archives (fresh ids, e.g. a scanned sync folder).
 */
export const applyArchiveImport = async (opts: {
  archive: ParsedArchive;
  resolution: ConflictResolution | null;
  excalidrawAPI: ExcalidrawImperativeAPI;
  mode?: "merge" | "replace";
}): Promise<{ importedScenes: number }> => {
  const { manifest, sceneFiles } = opts.archive;

  if (appJotaiStore.get(isCollaboratingAtom)) {
    return { importedScenes: 0 };
  }

  const conflicts = detectConflicts(manifest, getScenesIndex());
  const hasConflicts =
    conflicts.sceneConflicts.length > 0 ||
    conflicts.collectionConflicts.length > 0;
  if (hasConflicts && !opts.resolution) {
    throw new Error("Conflict resolution required but not provided.");
  }

  const overwrittenScenes = new Set(
    opts.resolution === "overwrite" ? conflicts.sceneConflicts : [],
  );
  const activeSceneId = getScenesIndex().activeSceneId;
  const isActiveSceneOverwritten = overwrittenScenes.has(activeSceneId);

  if (isActiveSceneOverwritten) {
    // drop the pending debounced save of the scene being replaced — a late
    // flush would clobber the imported data
    LocalData.cancelSave();
  } else {
    LocalData.flushSave();
  }

  // conflicting ids are remapped under "keep-both"; identity otherwise
  const sceneIdMap = new Map<SceneId, SceneId>();
  const collectionIdMap = new Map<CollectionId, CollectionId>();
  if (opts.resolution === "keep-both") {
    for (const id of conflicts.sceneConflicts) {
      sceneIdMap.set(id, newSceneId());
    }
    for (const id of conflicts.collectionConflicts) {
      collectionIdMap.set(id, newSceneId());
    }
  }
  const mappedSceneId = (id: SceneId) => sceneIdMap.get(id) ?? id;
  const mappedCollectionId = (id: CollectionId | null) =>
    id === null ? null : collectionIdMap.get(id) ?? id;
  const isRemappedScene = (id: SceneId) => sceneIdMap.has(id);

  // ---------------------------------------------------------------------
  // phase 1: write scene blobs (and their images into the shared IDB
  // store — content-addressed fileIds, so re-imports dedupe for free)
  // ---------------------------------------------------------------------
  const writtenNewIds: SceneId[] = [];
  const importedSceneIds = new Set<SceneId>();
  const existingSceneIds = new Set(
    getScenesIndex().scenes.map((scene) => scene.id),
  );

  try {
    for (const entry of manifest.scenes) {
      const bytes = sceneFiles.get(entry.id)!;
      let data;
      try {
        data = await loadFromBlob(
          new Blob([bytes as BlobPart], { type: MIME_TYPES.excalidraw }),
          null,
          null,
        );
      } catch (error: any) {
        // corrupt entry — skip the scene rather than failing the import
        console.error(error);
        continue;
      }

      const targetId = mappedSceneId(entry.id);
      if (data.files && Object.keys(data.files).length) {
        await LocalData.fileStorage.saveFiles({
          elements: data.elements,
          files: data.files,
        });
      }
      if (!existingSceneIds.has(targetId)) {
        writtenNewIds.push(targetId);
      }
      await scenesStorage.saveScene(targetId, {
        elements: data.elements,
        appState: clearAppStateForLocalStorage(data.appState),
      });
      importedSceneIds.add(entry.id);
    }
  } catch (error: any) {
    // roll back blobs the index doesn't reference yet, then surface
    for (const id of writtenNewIds) {
      deleteSceneSync(id);
    }
    if (isQuotaExceededError(error)) {
      appJotaiStore.set(localStorageQuotaExceededAtom, true);
      throw new Error(
        "Not enough browser storage to import this archive. Free up space and try again.",
      );
    }
    throw error;
  }

  if (!importedSceneIds.size) {
    return { importedScenes: 0 };
  }

  if (opts.mode === "replace") {
    const oldSceneIds = getScenesIndex().scenes.map((scene) => scene.id);
    const scenes: SceneMeta[] = [];
    for (const entry of manifest.scenes) {
      if (!importedSceneIds.has(entry.id)) {
        continue;
      }
      scenes.push({
        id: mappedSceneId(entry.id),
        name: entry.name,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        collectionId: mappedCollectionId(entry.collectionId),
      });
    }
    const keptIds = new Set(scenes.map((scene) => scene.id));
    const activeId = scenes[0].id;

    // the outgoing active scene dies with the workspace — a late flush of
    // its debounced save would write a blob the new index doesn't know
    LocalData.cancelSave();
    LocalData.pauseSave("switchingScene");
    try {
      setScenesIndex({
        version: 1,
        activeSceneId: activeId,
        scenes,
        collections: [...manifest.collections],
      });
      // only after the commit, so a failure never half-deletes the old
      // workspace (blobs for the new one roll back via phase 1)
      for (const id of oldSceneIds) {
        if (!keptIds.has(id)) {
          deleteSceneSync(id);
        }
      }
      await applyStoredScene(activeId, opts.excalidrawAPI);
    } finally {
      LocalData.resumeSave("switchingScene");
    }
    return { importedScenes: importedSceneIds.size };
  }

  // ---------------------------------------------------------------------
  // phase 2: single index commit
  // ---------------------------------------------------------------------
  const commitIndex = () => {
    // re-read — the flush above may have bumped the outgoing scene's meta
    const index = getScenesIndex();

    const collections = [...getCollections(index)];
    const collectionPosition = new Map(
      collections.map((collection, position) => [collection.id, position]),
    );
    for (const entry of manifest.collections) {
      const targetId = mappedCollectionId(entry.id)!;
      const imported: CollectionMeta = { ...entry, id: targetId };
      if (opts.resolution === "keep-both" && collectionIdMap.has(entry.id)) {
        imported.name = `${imported.name}${IMPORTED_SUFFIX}`;
      }
      const position = collectionPosition.get(targetId);
      if (position !== undefined) {
        collections[position] = imported;
      } else {
        collectionPosition.set(targetId, collections.length);
        collections.push(imported);
      }
    }

    const scenes = [...index.scenes];
    const scenePosition = new Map(
      scenes.map((scene, position) => [scene.id, position]),
    );
    for (const entry of manifest.scenes) {
      if (!importedSceneIds.has(entry.id)) {
        continue;
      }
      const targetId = mappedSceneId(entry.id);
      const imported: SceneMeta = {
        id: targetId,
        name: isRemappedScene(entry.id)
          ? `${entry.name}${IMPORTED_SUFFIX}`
          : entry.name,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        collectionId: mappedCollectionId(entry.collectionId),
      };
      const position = scenePosition.get(targetId);
      if (position !== undefined) {
        scenes[position] = imported;
      } else {
        scenePosition.set(targetId, scenes.length);
        scenes.push(imported);
      }
    }

    setScenesIndex({ ...index, collections, scenes });
  };

  if (isActiveSceneOverwritten) {
    LocalData.pauseSave("switchingScene");
    try {
      commitIndex();
      await applyStoredScene(activeSceneId, opts.excalidrawAPI);
    } finally {
      LocalData.resumeSave("switchingScene");
    }
  } else {
    commitIndex();
  }

  return { importedScenes: importedSceneIds.size };
};
