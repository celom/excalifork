/**
 * Two-way scene sync for signed-in users.
 *
 * Same premise as the folder mirror (`folderSync.ts`), and the same reconcile
 * loop (`mirrorEngine.ts`): localStorage is the synchronous source of truth,
 * every index change flows through `scenesIndexAtom`, and a debounced
 * idempotent pass brings the destination back in line. Two things differ.
 *
 * **It reads back.** A folder is a one-way mirror because the filesystem has
 * no notion of which side is newer and disk edits aren't watched. An account
 * is shared between devices, so the pass merges rather than overwrites — see
 * `cloudMerge.ts` for the rules, which are the part that can lose data and
 * are therefore pure and directly tested. Remote changes arrive live via
 * `onSnapshot`, so a second device shows up within a second or two rather
 * than at the next local edit.
 *
 * **Payloads are pulled lazily.** The pass syncs metadata for every scene but
 * downloads a blob only when the scene is opened. Eager download would be
 * simpler, but the local store is localStorage with its ~5MB ceiling, and an
 * account can hold far more than one browser can — so a scene arrives as
 * metadata with `materialized: false` and `applyStoredScene` fetches it on
 * demand (via the `materialize.ts` registration point). That flag already
 * existed for exactly this; the guards on it are what stop an undownloaded
 * scene from being read as an empty one and replicated over the real data.
 *
 * Ordering inside a pass is deliberate: payloads are written before the
 * metadata that points at them, and the local half of the merge is applied
 * synchronously right after it is computed, so no `await` can let a user edit
 * slip in between deciding and applying.
 */

import { isInitializedImageElement } from "@excalidraw/element";
import { createStore, del, get, set } from "idb-keyval";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom } from "../app-jotai";
import { authUserAtom, getCurrentUid, isAuthAvailable } from "../data/auth";
import {
  deleteSceneBlob,
  downloadFiles,
  downloadSceneBlob,
  loadRemoteIndex,
  saveRemoteIndex,
  subscribeToRemoteIndex,
  uploadFile,
  uploadSceneBlob,
} from "../data/cloudStorage";
import { LocalData } from "../data/LocalData";

import { applyStoredScene } from "./actions";
import { emptyCloudSyncRecord, mergeCloudIndex } from "./cloudMerge";
import { setSceneMaterializer } from "./materialize";
import { createMirrorEngine } from "./mirrorEngine";
import { getActiveSceneId, getScenesIndex, setScenesIndex } from "./state";
import {
  deleteSceneSync,
  hasSceneBlobSync,
  loadSceneSync,
  newSceneId,
  saveSceneSync,
} from "./storage";

import type { CloudMergePlan, CloudSyncRecord } from "./cloudMerge";
import type { SceneId, SceneMeta } from "./storage";

export type CloudSyncStatus =
  /** signed out, or auth not built into this deployment */
  | "off"
  /** a pass is in flight and has not yet settled */
  | "syncing"
  | "active"
  | "error";

export const cloudSyncStatusAtom = atom<CloudSyncStatus>("off");
export const cloudSyncErrorAtom = atom<string | null>(null);
/** scenes listed in the workspace whose payload is not on this device yet */
export const cloudSyncPendingAtom = atom(0);

const CLOUD_SYNC_DEBOUNCE_TIMEOUT = 2000;
/** a lost write race is a retry, not a failure; give up only if it persists */
const MAX_WRITE_ATTEMPTS = 3;

const syncStore = createStore("cloud-sync-db", "cloud-sync-store");

let record: CloudSyncRecord | null = null;
/** the uid `start` is mid-flight for, before `record` exists to say so */
let startingUid: string | null = null;
let unsubscribeRemote: (() => void) | null = null;
let editorAPI: ExcalidrawImperativeAPI | null = null;

// -----------------------------------------------------------------------------
// status
// -----------------------------------------------------------------------------

const setStatus = (status: CloudSyncStatus, error: string | null = null) => {
  appJotaiStore.set(cloudSyncStatusAtom, status);
  appJotaiStore.set(cloudSyncErrorAtom, error);
};

const updatePendingCount = () => {
  appJotaiStore.set(
    cloudSyncPendingAtom,
    getScenesIndex().scenes.filter((scene) => scene.materialized === false)
      .length,
  );
};

/**
 * Firebase's messages name the rule that rejected the call, not what the user
 * should do. These are the ones a correctly-built deployment can still hit;
 * the rest fall through with whatever Firebase said.
 */
const describeError = (error: any): string => {
  switch (error?.code) {
    case "permission-denied":
    case "storage/unauthorized":
      return "This account isn't allowed to store scenes here — check the Firestore and Storage rules.";
    case "unavailable":
    case "storage/retry-limit-exceeded":
      return "Can't reach the server. Scenes are safe on this device and will sync when the connection is back.";
    default:
      return error?.message ?? "Cloud sync failed.";
  }
};

const persistRecord = async () => {
  if (record) {
    try {
      await set(record.uid, record, syncStore);
    } catch (error: any) {
      // the record is an optimization, not data — a lost one costs a round of
      // redundant uploads on the next pass, nothing more
      console.error(error);
    }
  }
};

// -----------------------------------------------------------------------------
// payload transfer
// -----------------------------------------------------------------------------

const imageFileIds = (elements: readonly ExcalidrawElement[]): FileId[] => {
  const ids = new Set<FileId>();
  for (const element of elements) {
    if (!element.isDeleted && isInitializedImageElement(element)) {
      ids.add(element.fileId);
    }
  }
  return [...ids];
};

/** content-addressed, so an id already in the record never needs re-sending */
const pushSceneFiles = async (
  uid: string,
  elements: readonly ExcalidrawElement[],
) => {
  if (!record) {
    return;
  }
  const uploaded = new Set(record.files);
  const missing = imageFileIds(elements).filter((id) => !uploaded.has(id));
  if (!missing.length) {
    return;
  }
  const { loadedFiles } = await LocalData.fileStorage.getFiles(missing);
  for (const file of loadedFiles) {
    await uploadFile(uid, file);
    record.files.push(file.id);
  }
};

/** fetches the images a pulled scene references but this device lacks */
const pullSceneFiles = async (
  uid: string,
  elements: readonly ExcalidrawElement[],
) => {
  const ids = imageFileIds(elements);
  if (!ids.length) {
    return;
  }
  const { erroredFiles } = await LocalData.fileStorage.getFiles(ids);
  if (!erroredFiles.size) {
    return;
  }
  const { loadedFiles } = await downloadFiles(uid, [...erroredFiles.keys()]);
  if (!loadedFiles.length) {
    return;
  }
  const files: BinaryFiles = {};
  for (const file of loadedFiles) {
    files[file.id] = file;
  }
  await LocalData.fileStorage.saveFiles({ elements, files });
};

/**
 * Uploads one scene's payload. `meta` comes from the plan rather than a fresh
 * read: recording what was actually merged means an edit landing mid-pass
 * leaves the record disagreeing with the index, which is exactly the signal
 * the next pass needs to upload again.
 */
const pushScene = async (uid: string, meta: SceneMeta) => {
  if (!record) {
    return;
  }
  const data = loadSceneSync(meta.id);
  if (!data) {
    return;
  }
  // images first: a scene blob that lands before its pictures renders with
  // holes on the other device until the next pass
  await pushSceneFiles(uid, data.elements);
  await uploadSceneBlob(uid, meta.id, data);
  record.scenes[meta.id] = {
    updatedAt: meta.updatedAt,
    contentVersion: meta.contentVersion,
  };
};

// -----------------------------------------------------------------------------
// the pass
// -----------------------------------------------------------------------------

/**
 * Applies the local half of a merge. Synchronous on purpose — it runs
 * immediately after the merge is computed, so nothing can change the index
 * between deciding and applying.
 */
const applyPlanLocally = (plan: CloudMergePlan) => {
  const previousActiveId = getActiveSceneId();

  for (const id of [...plan.removals, ...plan.invalidated]) {
    deleteSceneSync(id);
  }

  engine.mute(() =>
    setScenesIndex((prev) => {
      // deleting the last scene elsewhere would otherwise leave nothing to
      // show; the workspace always holds at least one scene
      const now = Date.now();
      const scenes = plan.scenes.length
        ? plan.scenes
        : [
            {
              id: newSceneId(),
              name: "Untitled",
              createdAt: now,
              updatedAt: now,
            },
          ];
      return {
        ...prev,
        scenes,
        collections: plan.collections,
        // which scene is open is a property of this device, not the account
        activeSceneId: scenes.some((scene) => scene.id === prev.activeSceneId)
          ? prev.activeSceneId
          : scenes[0].id,
      };
    }),
  );

  updatePendingCount();

  // whether the merge moved the open scene out from under the editor. Only
  // two things can: it was deleted on another device, or another device's
  // newer version won and the local payload was dropped.
  return (
    plan.removals.includes(previousActiveId) ||
    plan.invalidated.includes(previousActiveId)
  );
};

const reapplyActiveScene = async () => {
  if (!editorAPI) {
    return;
  }
  // the editor is holding content that lost the merge — a pending autosave
  // would write it straight back over what we just pulled
  LocalData.cancelSave();
  LocalData.pauseSave("cloudSync");
  try {
    await applyStoredScene(getActiveSceneId(), editorAPI);
  } finally {
    LocalData.resumeSave("cloudSync");
  }
};

const pass = async () => {
  const uid = getCurrentUid();
  if (!uid || record?.uid !== uid) {
    return;
  }

  // carried across attempts: a retry re-merges against the already-applied
  // index, so only the first attempt can observe the open scene being pulled
  // out from under the editor
  let openSceneDisturbed = false;

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const remote = await loadRemoteIndex(uid);
    const local = getScenesIndex();
    const unmaterialized = new Set(
      local.scenes
        .filter((scene) => scene.materialized === false)
        .map((scene) => scene.id),
    );
    const plan = mergeCloudIndex({
      local,
      remote,
      record,
      // a scene awaiting download may still have the blob of the version it
      // lost, briefly, if the delete below failed. Treating that as a local
      // payload would upload the stale copy over the good remote one.
      hasLocalBlob: (id) => !unmaterialized.has(id) && hasSceneBlobSync(id),
      now: Date.now(),
    });

    const metaById = new Map(local.scenes.map((scene) => [scene.id, scene]));
    openSceneDisturbed = applyPlanLocally(plan) || openSceneDisturbed;

    for (const id of plan.uploads) {
      const meta = metaById.get(id);
      if (meta) {
        await pushScene(uid, meta);
      }
    }

    if (plan.remote) {
      const { committed } = await saveRemoteIndex(
        uid,
        plan.remote,
        remote?.updatedAt ?? null,
      );
      if (!committed) {
        // another device wrote between our read and our write. The uploads
        // above already landed and the record now says so, so retrying costs
        // one more read, not one more upload.
        continue;
      }
    }

    for (const id of plan.remoteRemovals) {
      await deleteSceneBlob(uid, id);
    }
    // a sign-out can land in any of the awaits above, which drops the record
    if (record?.uid !== uid) {
      return;
    }
    for (const id of plan.forget) {
      delete record.scenes[id];
    }
    await persistRecord();
    if (openSceneDisturbed) {
      await reapplyActiveScene();
    }
    return;
  }

  // persistent contention — leave it to the next pass rather than error out
  console.warn("cloud sync: lost the index write race, retrying shortly");
  engine.schedule();
};

const engine = createMirrorEngine({
  pass,
  debounceTimeout: CLOUD_SYNC_DEBOUNCE_TIMEOUT,
  onSettled: () => {
    if (record) {
      setStatus("active");
    }
  },
  onError: (error: any) => {
    console.error(error);
    setStatus("error", describeError(error));
  },
});

// -----------------------------------------------------------------------------
// lazy payload fetch
// -----------------------------------------------------------------------------

/**
 * Downloads one scene's payload and marks it local. Registered as the
 * materializer, so `applyStoredScene` calls this instead of refusing to open
 * a scene it doesn't hold.
 */
const materializeSceneFromCloud = async (id: SceneId): Promise<boolean> => {
  const uid = getCurrentUid();
  if (!uid || record?.uid !== uid) {
    return false;
  }
  const meta = getScenesIndex().scenes.find((scene) => scene.id === id);
  if (!meta) {
    return false;
  }

  try {
    const data = await downloadSceneBlob(uid, id);
    // no blob ≡ an empty scene: one created on another device and synced
    // before anything was drawn on it
    const elements = data?.elements ?? [];
    // images before the flag flips, so the scene never renders with holes
    await pullSceneFiles(uid, elements);
    saveSceneSync(id, { elements, appState: data?.appState ?? {} });

    record.scenes[id] = {
      updatedAt: meta.updatedAt,
      contentVersion: meta.contentVersion,
    };
    engine.mute(() =>
      setScenesIndex((prev) => ({
        ...prev,
        scenes: prev.scenes.map((scene) =>
          scene.id === id ? { ...scene, materialized: true } : scene,
        ),
      })),
    );
    await persistRecord();
    updatePendingCount();
    return true;
  } catch (error: any) {
    console.error(error);
    setStatus("error", describeError(error));
    return false;
  }
};

// -----------------------------------------------------------------------------
// lifecycle
// -----------------------------------------------------------------------------

const start = async (uid: string) => {
  if (record?.uid === uid || startingUid === uid) {
    return;
  }
  stop();
  // after `stop`, which clears it: `record` isn't set until the IDB read
  // below resolves, so it can't be what keeps a second auth event from
  // starting a duplicate engine
  startingUid = uid;

  let stored: CloudSyncRecord | undefined;
  try {
    stored = await get(uid, syncStore);
  } catch (error: any) {
    console.error(error);
  }
  if (startingUid !== uid) {
    // signed out, or switched accounts, while that read was in flight
    return;
  }
  record =
    stored?.version === 1 && stored.uid === uid
      ? stored
      : emptyCloudSyncRecord(uid);

  setStatus("syncing");
  engine.start();
  unsubscribeRemote = subscribeToRemoteIndex(
    uid,
    () => engine.schedule(),
    (error) => {
      console.error(error);
      setStatus("error", describeError(error));
    },
  );
  await engine.reconcile();
};

/**
 * Signing out leaves the local scenes alone — localStorage is the source of
 * truth and nothing here was ever only in the cloud, with one exception:
 * scenes pulled as metadata whose payload was never downloaded. Those are not
 * local data, and leaving them would put unopenable rows in the sidebar with
 * no way to fetch them. They come back on the next sign-in.
 */
const stop = () => {
  engine.stop();
  unsubscribeRemote?.();
  unsubscribeRemote = null;
  record = null;
  startingUid = null;
  setStatus("off");

  const index = getScenesIndex();
  const kept = index.scenes.filter((scene) => scene.materialized !== false);
  if (kept.length !== index.scenes.length) {
    const now = Date.now();
    // signing out on a device that only ever held pulled scenes would
    // otherwise leave an index with no scenes at all, which won't load back
    const scenes = kept.length
      ? kept
      : [
          {
            id: newSceneId(),
            name: "Untitled",
            createdAt: now,
            updatedAt: now,
          },
        ];
    setScenesIndex({
      ...index,
      scenes,
      activeSceneId: scenes.some((scene) => scene.id === index.activeSceneId)
        ? index.activeSceneId
        : scenes[0].id,
    });
  }
  updatePendingCount();
};

/**
 * Lets the engine re-render the open scene when a remote edit wins for it.
 * Called from the app once the editor exists; passing null on teardown keeps
 * a stale API from a previous mount out of the way.
 */
export const setCloudSyncEditor = (api: ExcalidrawImperativeAPI | null) => {
  editorAPI = api;
};

/**
 * Follows the auth session: sync runs exactly while someone is signed in.
 * Idempotent, returns a teardown — safe to call from an effect that re-runs.
 */
export const initCloudSync = () => {
  if (!isAuthAvailable()) {
    return () => {};
  }
  setSceneMaterializer(materializeSceneFromCloud);

  const apply = () => {
    const uid = appJotaiStore.get(authUserAtom)?.uid ?? null;
    if (uid) {
      start(uid);
    } else if (record || startingUid) {
      // `startingUid` too: signing out while a start is mid-flight must
      // cancel it, and only `stop` clears the marker that would let it finish
      stop();
    }
  };

  apply();
  const unsubscribe = appJotaiStore.sub(authUserAtom, apply);

  return () => {
    unsubscribe();
    setSceneMaterializer(null);
    stop();
  };
};

/** clears this device's record of what it has pushed — the next pass then
 * re-uploads everything. Exported for tests and for a manual repair path. */
export const forgetCloudSyncRecord = async (uid: string) => {
  try {
    await del(uid, syncStore);
  } catch (error: any) {
    console.error(error);
  }
};
