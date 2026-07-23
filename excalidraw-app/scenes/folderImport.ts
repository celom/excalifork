/**
 * Folder-sync import: scans a picked directory for existing `.excalidraw`
 * files so enabling folder sync can offer to bring them into the
 * workspace (append or replace) instead of silently mirroring over them.
 *
 * The scan covers only the layout the mirror itself writes (see
 * serialize.ts `buildScenePaths`): files at the root plus files directly
 * inside top-level subfolders. Deeper nesting is deliberately ignored —
 * unlike `planFromEntries`' zip behavior of collapsing deep paths — so
 * sync never touches files it wouldn't have written.
 *
 * Scanned entries are wrapped as a `ParsedArchive` so the archive-import
 * pipeline (import.ts `applyArchiveImport`) is reused verbatim.
 */

import { blobToArrayBuffer } from "@excalidraw/excalidraw/data/blob";

import { planFromEntries } from "./archive";
import { sanitizeFilename, SCENE_FILE_EXTENSION } from "./serialize";

import type { ArchiveManifest } from "./archive";
import type { ParsedArchive } from "./import";
import type { CollectionMeta, SceneId } from "./storage";

// lib.dom lacks the async-iteration members (same situation as the
// permission methods — see folderSync.ts)
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<
    FileSystemFileHandle | FileSystemDirectoryHandle
  >;
};

export type FolderScanEntry = { path: string; bytes: Uint8Array };

const isSceneFile = (handle: { kind: string; name: string }) =>
  handle.kind === "file" &&
  !handle.name.startsWith(".") &&
  handle.name.toLowerCase().endsWith(SCENE_FILE_EXTENSION);

const readEntry = async (
  handle: FileSystemFileHandle,
  path: string,
): Promise<FolderScanEntry> => ({
  path,
  bytes: new Uint8Array(await blobToArrayBuffer(await handle.getFile())),
});

/**
 * Lists the folder's `.excalidraw` files — root level plus one level of
 * subfolders. Non-scene files, dot-entries and deeper nesting are
 * ignored. Throws on permission loss (`NotAllowedError`) — the caller
 * surfaces it.
 */
export const scanFolderForScenes = async (
  root: FileSystemDirectoryHandle,
): Promise<FolderScanEntry[]> => {
  const entries: FolderScanEntry[] = [];
  for await (const handle of (root as IterableDirectoryHandle).values()) {
    if (isSceneFile(handle)) {
      entries.push(
        await readEntry(handle as FileSystemFileHandle, handle.name),
      );
    } else if (handle.kind === "directory" && !handle.name.startsWith(".")) {
      const folder = handle.name;
      for await (const child of (handle as IterableDirectoryHandle).values()) {
        if (isSceneFile(child)) {
          entries.push(
            await readEntry(
              child as FileSystemFileHandle,
              `${folder}/${child.name}`,
            ),
          );
        }
      }
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
};

/**
 * Wraps scanned entries as a `ParsedArchive` for `applyArchiveImport`.
 * The manifest is synthesized via `planFromEntries`, so every scene and
 * collection gets a fresh id — imports can never id-conflict.
 */
export const folderEntriesToArchive = (
  entries: FolderScanEntry[],
): ParsedArchive => {
  const bytesByPath = new Map(
    entries.map((entry) => [entry.path, entry.bytes]),
  );
  const manifest = planFromEntries(entries.map((entry) => entry.path));
  const sceneFiles = new Map<SceneId, Uint8Array>();
  for (const scene of manifest.scenes) {
    sceneFiles.set(scene.id, bytesByPath.get(scene.path)!);
  }
  return { manifest, hadManifest: false, sceneFiles };
};

/**
 * Append-mode merge: a scanned folder whose name matches an existing
 * collection is merged into it — the synthesized collection is dropped
 * and its scenes retargeted to the existing collection's id. Names are
 * compared against `sanitizeFilename(existing.name)`, the exact folder
 * name the mirror writes, so re-importing a synced folder merges
 * correctly even where sanitization altered the name. First match wins.
 */
export const mergeCollectionsByName = (
  manifest: ArchiveManifest,
  existing: readonly CollectionMeta[],
): ArchiveManifest => {
  const existingByFolderName = new Map<string, CollectionMeta>();
  for (const collection of existing) {
    const folderName = sanitizeFilename(collection.name);
    if (!existingByFolderName.has(folderName)) {
      existingByFolderName.set(folderName, collection);
    }
  }

  const remap = new Map<string, string>();
  const collections = manifest.collections.filter((collection) => {
    const match = existingByFolderName.get(sanitizeFilename(collection.name));
    if (match) {
      remap.set(collection.id, match.id);
      return false;
    }
    return true;
  });

  if (!remap.size) {
    return manifest;
  }
  return {
    ...manifest,
    collections,
    scenes: manifest.scenes.map((scene) =>
      scene.collectionId && remap.has(scene.collectionId)
        ? { ...scene, collectionId: remap.get(scene.collectionId)! }
        : scene,
    ),
  };
};
