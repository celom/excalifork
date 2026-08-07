/**
 * The pure half of cloud sync: given the local index, the remote index and a
 * record of what this device last pushed, decide what moves where.
 *
 * Kept free of Firebase and of the jotai store so the rules below can be
 * tested directly — they are where data gets lost if they are wrong.
 *
 * ## The model
 *
 * Per-scene last-write-wins on `updatedAt`. Scenes here are single-user
 * documents (collab rooms are a different system entirely), so the only real
 * conflict is the same person on two devices, and the newer edit winning is
 * both what they expect and the only rule that converges without a merge UI.
 * Element-level merging exists in `reconcileElements`, but it needs both
 * sides' elements in memory, which would mean downloading every scene on
 * every pass.
 *
 * ## Why the `synced` record exists
 *
 * Without it, "this scene is gone from the local index" is ambiguous: it
 * either was deleted here, or has not been pulled yet. The record says which —
 * an id we previously pushed and no longer hold was deleted here. This is the
 * same trick `computeSyncOps` uses for folder sync, where the `synced` map
 * distinguishes a file we wrote and must now remove from a file we never
 * touched.
 *
 * ## Tombstones
 *
 * A delete cannot be represented by absence: the other device still has the
 * scene in its index and would push it straight back. So deletes write a
 * `deleted[id] = timestamp` entry, which is itself subject to last-write-wins
 * (edit an already-deleted scene on another device and the edit resurrects
 * it). Tombstones are pruned after `TOMBSTONE_TTL`, long past the point where
 * a device could still be carrying the deleted scene.
 */

import type {
  CollectionId,
  CollectionMeta,
  SceneId,
  SceneMeta,
  ScenesIndex,
} from "./storage";

/** `materialized` is a local fact — whether *this* device holds the blob */
export type RemoteSceneMeta = Omit<SceneMeta, "materialized">;

export type RemoteIndex = {
  version: 1;
  scenes: RemoteSceneMeta[];
  collections: CollectionMeta[];
  /** id → deletion timestamp, for both scenes and collections */
  deleted: Record<string, number>;
  /** writer's clock at the last write — doubles as the optimistic-concurrency
   * token for {@link saveRemoteIndex} */
  updatedAt: number;
};

/** what this device last pushed, per id */
export type SyncedScene = { updatedAt: number; contentVersion?: number };

export type CloudSyncRecord = {
  version: 1;
  uid: string;
  scenes: Record<SceneId, SyncedScene>;
  /** collection id → last pushed `updatedAt` */
  collections: Record<CollectionId, number>;
  /** content-addressed, so an uploaded file never needs re-uploading */
  files: string[];
};

export const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000;

export const emptyCloudSyncRecord = (uid: string): CloudSyncRecord => ({
  version: 1,
  uid,
  scenes: {},
  collections: {},
  files: [],
});

// -----------------------------------------------------------------------------
// the per-id decision
// -----------------------------------------------------------------------------

export type MergeDecision =
  /** local is the winner and differs from remote — push it */
  | "keep-local"
  /** remote is the winner — take its metadata */
  | "take-remote"
  /** remote has it, we never did — add it locally */
  | "add-remote"
  /** remote tombstone outlives the local copy — drop it here */
  | "delete-local"
  /** we pushed it once and no longer hold it — tombstone it remotely */
  | "tombstone"
  /** never pushed and never had content — don't create it remotely */
  | "skip-push"
  /** both sides agree */
  | "unchanged";

export const decideMerge = ({
  local,
  remote,
  synced,
  tombstone,
  isPristine,
}: {
  local: number | undefined;
  remote: number | undefined;
  /** `updatedAt` of the last value this device pushed for the id */
  synced: number | undefined;
  tombstone: number | undefined;
  /** local-only and never held content (a fresh browser's starter scene) */
  isPristine?: boolean;
}): MergeDecision => {
  if (local != null && remote == null) {
    if (tombstone != null && tombstone >= local) {
      // deleted on another device, and not touched here since
      return "delete-local";
    }
    if (synced == null && isPristine) {
      // every new browser mints a starter scene; pushing them would litter
      // the account with an "Untitled" per device
      return "skip-push";
    }
    // new here, edited after a remote delete, or lost remotely — (re)push
    return "keep-local";
  }

  if (local == null && remote != null) {
    if (synced != null && remote <= synced) {
      // we pushed this and no longer hold it: deleted here
      return "tombstone";
    }
    // never seen here, or edited elsewhere after our delete — take it
    return "add-remote";
  }

  if (local != null && remote != null) {
    if (local > remote) {
      return "keep-local";
    }
    if (remote > local) {
      return "take-remote";
    }
    return "unchanged";
  }

  return "unchanged";
};

// -----------------------------------------------------------------------------
// the whole-index merge
// -----------------------------------------------------------------------------

export type CloudMergePlan = {
  /** scenes for the local index, in a stable order */
  scenes: SceneMeta[];
  collections: CollectionMeta[];
  /** scene blobs to upload */
  uploads: SceneId[];
  /** scenes taken from remote whose local blob is now stale — the blob is
   * dropped and re-fetched when the scene is next opened */
  invalidated: SceneId[];
  /** scenes to drop locally, blob included */
  removals: SceneId[];
  /** scene blobs to delete remotely */
  remoteRemovals: SceneId[];
  /** the doc to write, or null when remote already says this */
  remote: RemoteIndex | null;
  /** ids to forget from the record (deleted on either side) */
  forget: SceneId[];
};

/** stable comparison of everything except the write clock */
const remoteContentEquals = (a: RemoteIndex, b: RemoteIndex) =>
  JSON.stringify([a.scenes, a.collections, a.deleted]) ===
  JSON.stringify([b.scenes, b.collections, b.deleted]);

/** Firestore rejects documents containing `undefined` */
const stripUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;

/** drops the local-only `materialized` flag on the way out */
const toRemoteScene = (scene: SceneMeta): RemoteSceneMeta => {
  const remote = stripUndefined({ ...scene });
  delete (remote as SceneMeta).materialized;
  return remote;
};

const collectionUpdatedAt = (collection: CollectionMeta) =>
  collection.updatedAt ?? collection.createdAt;

export const mergeCloudIndex = ({
  local,
  remote,
  record,
  hasLocalBlob,
  now,
}: {
  local: ScenesIndex;
  remote: RemoteIndex | null;
  record: CloudSyncRecord;
  /** whether the scene's payload is actually written locally */
  hasLocalBlob: (id: SceneId) => boolean;
  now: number;
}): CloudMergePlan => {
  const localById = new Map(local.scenes.map((scene) => [scene.id, scene]));
  const remoteById = new Map(
    (remote?.scenes ?? []).map((scene) => [scene.id, scene]),
  );
  const tombstones: Record<string, number> = { ...(remote?.deleted ?? {}) };

  const scenes: SceneMeta[] = [];
  /** local-only and deliberately not published — held back from the doc as
   * well as from the uploads, or "don't push it" would only mean "don't push
   * its payload" and the account would collect an entry per device anyway */
  const unpublished = new Set<SceneId>();
  const uploads: SceneId[] = [];
  const invalidated: SceneId[] = [];
  const removals: SceneId[] = [];
  const remoteRemovals: SceneId[] = [];
  const forget: SceneId[] = [];

  // local order first so the sidebar doesn't reshuffle on every pull; scenes
  // that exist only remotely land at the end in remote order
  const ids = [
    ...local.scenes.map((scene) => scene.id),
    ...(remote?.scenes ?? [])
      .map((scene) => scene.id)
      .filter((id) => !localById.has(id)),
  ];

  for (const id of ids) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    const synced = record.scenes[id];

    const decision = decideMerge({
      local: l?.updatedAt,
      remote: r?.updatedAt,
      synced: synced?.updatedAt,
      tombstone: tombstones[id],
      isPristine: !!l && l.contentVersion === undefined && !hasLocalBlob(id),
    });

    switch (decision) {
      case "keep-local": {
        scenes.push(l!);
        delete tombstones[id];
        // metadata-only changes (rename, move to a collection) ride the index
        // doc; only a content change is worth re-uploading a blob for
        if (
          hasLocalBlob(id) &&
          (!synced || synced.contentVersion !== l!.contentVersion)
        ) {
          uploads.push(id);
        }
        break;
      }
      case "unchanged": {
        scenes.push(l!);
        // covers the first pass after a record was lost: metadata matches but
        // this device has never actually pushed the payload
        if (hasLocalBlob(id) && !synced) {
          uploads.push(id);
        }
        break;
      }
      case "skip-push": {
        scenes.push(l!);
        unpublished.add(id);
        break;
      }
      case "take-remote": {
        // the local blob belongs to the older version — only its metadata
        // survives the pull
        const stale = l!.contentVersion !== r!.contentVersion;
        if (stale && hasLocalBlob(id)) {
          invalidated.push(id);
        }
        scenes.push({
          ...r!,
          materialized: stale ? false : l!.materialized,
        });
        break;
      }
      case "add-remote": {
        scenes.push({ ...r!, materialized: false });
        delete tombstones[id];
        break;
      }
      case "delete-local": {
        removals.push(id);
        forget.push(id);
        break;
      }
      case "tombstone": {
        tombstones[id] = Math.max(tombstones[id] ?? 0, now);
        remoteRemovals.push(id);
        forget.push(id);
        break;
      }
    }
  }

  const collections = mergeCollections({
    local: local.collections ?? [],
    remote: remote?.collections ?? [],
    record,
    tombstones,
    now,
  });

  for (const [id, deletedAt] of Object.entries(tombstones)) {
    if (now - deletedAt > TOMBSTONE_TTL) {
      delete tombstones[id];
    }
  }

  const nextRemote: RemoteIndex = {
    version: 1,
    scenes: scenes
      .filter((scene) => !unpublished.has(scene.id))
      .map(toRemoteScene),
    collections: collections.map(stripUndefined),
    deleted: tombstones,
    updatedAt: now,
  };

  return {
    scenes,
    collections,
    uploads,
    invalidated,
    removals,
    remoteRemovals,
    forget,
    remote:
      remote && remoteContentEquals(remote, nextRemote) ? null : nextRemote,
  };
};

/**
 * Collections carry no payload, so this is the scene merge without the blob
 * bookkeeping. `updatedAt` is optional on `CollectionMeta` (it postdates the
 * type), and `createdAt` stands in for it — which is right for a collection
 * that was never renamed, the only way to be missing it.
 */
const mergeCollections = ({
  local,
  remote,
  record,
  tombstones,
  now,
}: {
  local: readonly CollectionMeta[];
  remote: readonly CollectionMeta[];
  record: CloudSyncRecord;
  tombstones: Record<string, number>;
  now: number;
}): CollectionMeta[] => {
  const localById = new Map(local.map((c) => [c.id, c]));
  const remoteById = new Map(remote.map((c) => [c.id, c]));
  const merged: CollectionMeta[] = [];

  const ids = [
    ...local.map((c) => c.id),
    ...remote.map((c) => c.id).filter((id) => !localById.has(id)),
  ];

  for (const id of ids) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    const decision = decideMerge({
      local: l && collectionUpdatedAt(l),
      remote: r && collectionUpdatedAt(r),
      synced: record.collections[id],
      tombstone: tombstones[id],
    });

    switch (decision) {
      case "keep-local":
      case "unchanged":
      case "skip-push":
        merged.push(l!);
        delete tombstones[id];
        break;
      case "take-remote":
      case "add-remote":
        merged.push(r!);
        delete tombstones[id];
        break;
      case "tombstone":
        tombstones[id] = Math.max(tombstones[id] ?? 0, now);
        break;
      case "delete-local":
        break;
    }
  }

  return merged;
};
