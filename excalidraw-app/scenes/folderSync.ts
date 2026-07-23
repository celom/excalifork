/**
 * One-way folder sync: continuously mirrors the workspace into a
 * user-picked directory as real `.excalidraw` files (layout shared with
 * the archive export — see serialize.ts). Disk edits are NOT watched;
 * bringing files back in goes through the import flows — except at
 * activation, where a non-empty folder offers a one-time append/replace
 * import (see folderImport.ts).
 *
 * Chromium-only (File System Access API) — feature-detect with
 * `isFolderSyncSupported()` and hide the UI elsewhere.
 *
 * The directory handle and a `synced` map (sceneId → last written
 * path/updatedAt) persist in IndexedDB, so renames/moves/deletes diff
 * correctly across sessions. Writes are debounced off the scenes-index
 * atom — the single choke point every index change flows through — and
 * are fully try/caught so the primary localStorage save path can never
 * be affected. Known limitation: two tabs with granted permission both
 * mirror; writes are idempotent (same content, same paths), so harmless.
 */

import { debounce } from "@excalidraw/common";
import { createStore, del, get, set } from "idb-keyval";

import { appJotaiStore, atom } from "../app-jotai";

import { getCollections } from "./collections";
import { folderEntriesToArchive, scanFolderForScenes } from "./folderImport";
import { buildScenePaths, serializeSceneToString } from "./serialize";
import { getScenesIndex, scenesIndexAtom } from "./state";

import type { ParsedArchive } from "./import";
import type { ScenePathPlan } from "./serialize";
import type { SceneId, SceneMeta } from "./storage";

// lib.dom has the handle types but not the picker/permission methods
type PermissionDescriptor = { mode: "readwrite" };
type HandleWithPermissions = FileSystemDirectoryHandle & {
  queryPermission(desc: PermissionDescriptor): Promise<PermissionState>;
  requestPermission(desc: PermissionDescriptor): Promise<PermissionState>;
};

export type FolderSyncStatus =
  | "unsupported"
  | "off"
  | "active"
  | "needs-permission"
  | "error";

export const folderSyncStatusAtom = atom<FolderSyncStatus>("off");
export const folderSyncErrorAtom = atom<string | null>(null);
/** name of the synced directory — the File System Access API never
 * exposes the full path, only the picked directory's own name */
export const folderSyncFolderNameAtom = atom<string | null>(null);

/**
 * Set when the picked folder already contains `.excalidraw` files —
 * activation is parked until the user chooses append/replace/cancel in
 * <FolderSyncImportDialogs/>. Nothing is persisted while pending, so
 * cancelling leaves any previously running sync untouched.
 */
export type PendingFolderSyncImport = {
  handle: FileSystemDirectoryHandle;
  archive: ParsedArchive;
};
export const pendingFolderSyncImportAtom = atom<PendingFolderSyncImport | null>(
  null,
);
export const folderSyncImportErrorAtom = atom<string | null>(null);

export const isFolderSyncSupported = () =>
  typeof window !== "undefined" && "showDirectoryPicker" in window;

export type SyncedScenes = Record<SceneId, { path: string; updatedAt: number }>;

export type FolderSyncRecord = {
  version: 1;
  handle: FileSystemDirectoryHandle;
  synced: SyncedScenes;
};

const FOLDER_SYNC_DEBOUNCE_TIMEOUT = 1500;
const RECORD_KEY = "state";
const syncStore = createStore("folder-sync-db", "folder-sync-store");

// -----------------------------------------------------------------------------
// pure diff
// -----------------------------------------------------------------------------

export type SyncOps = {
  /** scenes whose file must be (re)written at `path` — new, content
   * changed, or path changed (a rename/move re-serializes; content isn't
   * cached anywhere to copy) */
  writes: { id: SceneId; path: string }[];
  /** stale files to remove — old paths of moved scenes, files of scenes
   * gone from the index */
  deletes: { path: string }[];
};

export const computeSyncOps = (
  synced: SyncedScenes,
  scenes: readonly SceneMeta[],
  paths: ScenePathPlan,
): SyncOps => {
  const writes: SyncOps["writes"] = [];
  const deletes: SyncOps["deletes"] = [];
  const liveIds = new Set<SceneId>();

  for (const scene of scenes) {
    liveIds.add(scene.id);
    const path = paths.get(scene.id)!;
    const prev = synced[scene.id];
    if (!prev) {
      writes.push({ id: scene.id, path });
      continue;
    }
    if (prev.updatedAt !== scene.updatedAt || prev.path !== path) {
      writes.push({ id: scene.id, path });
    }
    if (prev.path !== path) {
      deletes.push({ path: prev.path });
    }
  }

  for (const id of Object.keys(synced)) {
    if (!liveIds.has(id)) {
      deletes.push({ path: synced[id].path });
    }
  }

  return { writes, deletes };
};

// -----------------------------------------------------------------------------
// filesystem ops
// -----------------------------------------------------------------------------

const getDirectory = async (
  root: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
) => {
  let directory = root;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return directory;
};

const writeFile = async (
  root: FileSystemDirectoryHandle,
  path: string,
  content: string,
) => {
  const segments = path.split("/");
  const filename = segments.pop()!;
  const directory = await getDirectory(root, segments, true);
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
};

/** best-effort — the mirror must not fail because a stale file is gone */
const removeFile = async (root: FileSystemDirectoryHandle, path: string) => {
  const segments = path.split("/");
  const filename = segments.pop()!;
  try {
    const directory = await getDirectory(root, segments, false);
    await directory.removeEntry(filename);
    // prune now-empty folders bottom-up (removeEntry rejects non-empty ones)
    for (let depth = segments.length; depth > 0; depth--) {
      const parent = await getDirectory(
        root,
        segments.slice(0, depth - 1),
        false,
      );
      await parent.removeEntry(segments[depth - 1]);
    }
  } catch {
    // permission problems will surface on the next write instead
  }
};

/**
 * One reconcile pass against the given record. Exported for tests — the
 * live engine calls it via the debounced index subscription. `synced` is
 * mutated and `persist`ed after each successful write, so an interrupted
 * pass resumes incrementally.
 */
export const syncScenesToFolder = async (opts: {
  root: FileSystemDirectoryHandle;
  synced: SyncedScenes;
  persist: () => Promise<void> | void;
}) => {
  const index = getScenesIndex();
  const paths = buildScenePaths(index.scenes, getCollections(index));
  const ops = computeSyncOps(opts.synced, index.scenes, paths);
  const metaById = new Map(index.scenes.map((scene) => [scene.id, scene]));

  for (const op of ops.writes) {
    const meta = metaById.get(op.id)!;
    const content = await serializeSceneToString(meta);
    await writeFile(opts.root, op.path, content);
    opts.synced[op.id] = { path: op.path, updatedAt: meta.updatedAt };
    await opts.persist();
  }

  // deletes after writes so a rename never has a window with no file
  for (const op of ops.deletes) {
    await removeFile(opts.root, op.path);
  }
  for (const id of Object.keys(opts.synced)) {
    if (!metaById.has(id)) {
      delete opts.synced[id];
    }
  }
  await opts.persist();
};

// -----------------------------------------------------------------------------
// engine
// -----------------------------------------------------------------------------

let record: FolderSyncRecord | null = null;
let unsubscribeIndex: (() => void) | null = null;
let running = false;
let dirty = false;

const setStatus = (status: FolderSyncStatus, error: string | null = null) => {
  appJotaiStore.set(folderSyncStatusAtom, status);
  appJotaiStore.set(folderSyncErrorAtom, error);
  appJotaiStore.set(folderSyncFolderNameAtom, record?.handle.name ?? null);
};

const persistRecord = async () => {
  if (record) {
    await set(RECORD_KEY, record, syncStore);
  }
};

const reconcile = async () => {
  if (!record) {
    return;
  }
  if (running) {
    // an index change landed mid-pass — run again when it finishes
    dirty = true;
    return;
  }
  running = true;
  try {
    do {
      dirty = false;
      await syncScenesToFolder({
        root: record.handle,
        synced: record.synced,
        persist: persistRecord,
      });
    } while (dirty);
    setStatus("active");
  } catch (error: any) {
    console.error(error);
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      setStatus("needs-permission");
    } else if (error?.name === "NotFoundError") {
      setStatus(
        "error",
        "The sync folder is missing — it may have been moved or deleted.",
      );
    } else {
      setStatus("error", error?.message || "Folder sync failed.");
    }
  } finally {
    running = false;
  }
};

const scheduleReconcile = debounce(() => {
  reconcile();
}, FOLDER_SYNC_DEBOUNCE_TIMEOUT);

const subscribeToIndex = () => {
  if (!unsubscribeIndex) {
    unsubscribeIndex = appJotaiStore.sub(scenesIndexAtom, () => {
      scheduleReconcile();
    });
  }
};

const stopEngine = () => {
  scheduleReconcile.cancel();
  unsubscribeIndex?.();
  unsubscribeIndex = null;
};

// -----------------------------------------------------------------------------
// public API
// -----------------------------------------------------------------------------

/** app-boot: resume a previously enabled sync if permission survived */
export const initFolderSync = async () => {
  if (!isFolderSyncSupported()) {
    setStatus("unsupported");
    return;
  }
  let stored: FolderSyncRecord | undefined;
  try {
    stored = await get(RECORD_KEY, syncStore);
  } catch (error: any) {
    console.error(error);
  }
  if (!stored || stored.version !== 1) {
    setStatus("off");
    return;
  }
  record = stored;
  try {
    const permission = await (
      record.handle as HandleWithPermissions
    ).queryPermission({ mode: "readwrite" });
    if (permission === "granted") {
      subscribeToIndex();
      setStatus("active");
      await reconcile();
    } else {
      // requestPermission needs a user gesture — the UI offers a resume
      // button
      setStatus("needs-permission");
    }
  } catch (error: any) {
    console.error(error);
    setStatus("error", error?.message || "Folder sync failed to resume.");
  }
};

/**
 * Commit point: persist the handle and start mirroring. `synced` starts
 * empty even when the folder's files were just imported — the first pass
 * then has no delete ops, so the mirror can never remove a file it didn't
 * write (path-plan dedup may hand a pre-existing file's path to another
 * scene). Consequences: imported files are rewritten in place with
 * round-tripped content, and a file whose name sanitization changed stays
 * behind as an unmanaged leftover.
 */
export const activateFolderSync = async (handle: FileSystemDirectoryHandle) => {
  stopEngine();
  record = { version: 1, handle, synced: {} };
  await persistRecord();
  subscribeToIndex();
  setStatus("active");
  await reconcile();
};

/**
 * user gesture: pick a folder and mirror everything into it. If the
 * folder already contains `.excalidraw` files, activation is parked in
 * `pendingFolderSyncImportAtom` — the app-wide dialogs finish (or cancel)
 * the flow.
 */
export const enableFolderSync = async () => {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await (window as any).showDirectoryPicker({
      mode: "readwrite",
      id: "excalidraw-folder-sync",
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      return;
    }
    throw error;
  }
  try {
    const entries = await scanFolderForScenes(handle);
    if (entries.length) {
      appJotaiStore.set(pendingFolderSyncImportAtom, {
        handle,
        archive: folderEntriesToArchive(entries),
      });
      return;
    }
  } catch (error: any) {
    console.error(error);
    appJotaiStore.set(
      folderSyncImportErrorAtom,
      "Couldn't read the selected folder. Folder sync was not enabled.",
    );
    return;
  }
  await activateFolderSync(handle);
};

/** user gesture: re-grant permission for the persisted folder */
export const reenableFolderSync = async () => {
  if (!record) {
    return;
  }
  try {
    const permission = await (
      record.handle as HandleWithPermissions
    ).requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      return;
    }
  } catch (error: any) {
    console.error(error);
    setStatus("error", error?.message || "Couldn't re-enable folder sync.");
    return;
  }
  subscribeToIndex();
  setStatus("active");
  await reconcile();
};

/** stops mirroring; files already written stay on disk */
export const disableFolderSync = async () => {
  stopEngine();
  record = null;
  setStatus("off");
  try {
    await del(RECORD_KEY, syncStore);
  } catch (error: any) {
    console.error(error);
  }
};
