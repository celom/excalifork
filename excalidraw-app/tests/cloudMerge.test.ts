/**
 * The cloud-sync merge rules (scenes/cloudMerge.ts).
 *
 * These decide what gets kept, overwritten and deleted across devices, so
 * every case below is a way a user's drawing could disappear if the rule is
 * wrong. The engine around them is I/O; this is the part worth pinning.
 */

import {
  emptyCloudSyncRecord,
  mergeCloudIndex,
  TOMBSTONE_TTL,
} from "../scenes/cloudMerge";

import type { CloudSyncRecord, RemoteIndex } from "../scenes/cloudMerge";
import type { SceneMeta, ScenesIndex } from "../scenes/storage";

const NOW = 1_000_000;

const scene = (
  id: string,
  updatedAt: number,
  extra: Partial<SceneMeta> = {},
): SceneMeta => ({
  id,
  name: id,
  createdAt: 1,
  updatedAt,
  contentVersion: updatedAt,
  ...extra,
});

const localIndex = (scenes: SceneMeta[]): ScenesIndex => ({
  version: 1,
  activeSceneId: scenes[0]?.id ?? "none",
  scenes,
});

const remoteIndex = (
  scenes: SceneMeta[],
  deleted: Record<string, number> = {},
): RemoteIndex => ({
  version: 1,
  scenes,
  collections: [],
  deleted,
  updatedAt: 500,
});

const recordWith = (
  scenes: CloudSyncRecord["scenes"] = {},
): CloudSyncRecord => ({ ...emptyCloudSyncRecord("uid"), scenes });

const merge = (opts: {
  local: ScenesIndex;
  remote?: RemoteIndex | null;
  record?: CloudSyncRecord;
  /** ids with a payload on this device — defaults to every local scene */
  blobs?: string[];
  now?: number;
}) =>
  mergeCloudIndex({
    local: opts.local,
    remote: opts.remote ?? null,
    record: opts.record ?? recordWith(),
    hasLocalBlob: (id) =>
      opts.blobs
        ? opts.blobs.includes(id)
        : opts.local.scenes.some((s) => s.id === id),
    now: opts.now ?? NOW,
  });

const ids = (scenes: readonly SceneMeta[]) => scenes.map((s) => s.id);

describe("first sign-in", () => {
  it("unions both sides rather than either replacing the other", () => {
    const plan = merge({
      local: localIndex([scene("local", 10)]),
      remote: remoteIndex([scene("remote", 20)]),
    });

    expect(ids(plan.scenes)).toEqual(["local", "remote"]);
    expect(plan.uploads).toEqual(["local"]);
    expect(plan.removals).toEqual([]);
  });

  it("marks scenes arriving from the account as not downloaded", () => {
    const plan = merge({
      local: localIndex([scene("local", 10)]),
      remote: remoteIndex([scene("remote", 20)]),
    });

    expect(plan.scenes.find((s) => s.id === "remote")?.materialized).toBe(
      false,
    );
    // a scene we already hold must not be flagged, or opening it would try to
    // download over the copy that is right there
    expect(plan.scenes.find((s) => s.id === "local")?.materialized).toBe(
      undefined,
    );
  });

  it("does not push the starter scene a fresh browser mints", () => {
    // every new browser creates an "Untitled" on first load. Pushing them
    // would litter the account with one per device.
    const pristine = scene("starter", 10, { contentVersion: undefined });
    const plan = merge({
      local: localIndex([pristine, scene("drawn", 15)]),
      remote: remoteIndex([scene("real", 20)]),
      blobs: ["drawn"],
    });

    expect(plan.uploads).toEqual(["drawn"]);
    // the doc is rewritten to carry "drawn" — and the starter is still not in it
    expect(plan.remote?.scenes.map((s) => s.id)).toEqual(["drawn", "real"]);
    // it stays usable locally — it just isn't the account's business
    expect(ids(plan.scenes)).toEqual(["starter", "drawn", "real"]);
  });
});

describe("last-write-wins", () => {
  it("keeps the newer local edit and queues it for upload", () => {
    const plan = merge({
      local: localIndex([scene("s", 30)]),
      remote: remoteIndex([scene("s", 20)]),
      record: recordWith({ s: { updatedAt: 20, contentVersion: 20 } }),
    });

    expect(plan.scenes[0].updatedAt).toBe(30);
    expect(plan.uploads).toEqual(["s"]);
    expect(plan.invalidated).toEqual([]);
  });

  it("takes the newer remote edit and drops the stale local payload", () => {
    const plan = merge({
      local: localIndex([scene("s", 20)]),
      remote: remoteIndex([scene("s", 30)]),
      record: recordWith({ s: { updatedAt: 20, contentVersion: 20 } }),
    });

    expect(plan.scenes[0].updatedAt).toBe(30);
    // the local blob belongs to the version that lost — keeping it would
    // render the old drawing under the new metadata
    expect(plan.invalidated).toEqual(["s"]);
    expect(plan.scenes[0].materialized).toBe(false);
    expect(plan.uploads).toEqual([]);
  });

  it("leaves the payload alone when only metadata moved", () => {
    // a rename or a move into a collection bumps updatedAt without touching
    // a single element; re-downloading the blob for that is pure waste
    const plan = merge({
      local: localIndex([scene("s", 20, { contentVersion: 7 })]),
      remote: remoteIndex([
        scene("s", 30, { contentVersion: 7, name: "renamed elsewhere" }),
      ]),
    });

    expect(plan.scenes[0].name).toBe("renamed elsewhere");
    expect(plan.invalidated).toEqual([]);
    expect(plan.scenes[0].materialized).toBe(undefined);
  });

  it("uploads on a content change but not on a metadata-only one", () => {
    const unchanged = merge({
      local: localIndex([scene("s", 30, { contentVersion: 5 })]),
      remote: remoteIndex([scene("s", 20, { contentVersion: 5 })]),
      record: recordWith({ s: { updatedAt: 20, contentVersion: 5 } }),
    });
    expect(unchanged.uploads).toEqual([]);
    // the index doc still has to be rewritten so the rename propagates
    expect(unchanged.remote).not.toBeNull();

    const edited = merge({
      local: localIndex([scene("s", 30, { contentVersion: 6 })]),
      remote: remoteIndex([scene("s", 20, { contentVersion: 5 })]),
      record: recordWith({ s: { updatedAt: 20, contentVersion: 5 } }),
    });
    expect(edited.uploads).toEqual(["s"]);
  });
});

describe("deletion", () => {
  it("tombstones a scene this device deleted", () => {
    const plan = merge({
      local: localIndex([scene("keep", 10)]),
      remote: remoteIndex([scene("keep", 10), scene("gone", 20)]),
      record: recordWith({
        keep: { updatedAt: 10, contentVersion: 10 },
        gone: { updatedAt: 20, contentVersion: 20 },
      }),
    });

    expect(plan.remote?.deleted).toEqual({ gone: NOW });
    expect(plan.remoteRemovals).toEqual(["gone"]);
    expect(plan.forget).toEqual(["gone"]);
    expect(ids(plan.scenes)).toEqual(["keep"]);
  });

  it("does not resurrect a scene deleted on another device", () => {
    const plan = merge({
      local: localIndex([scene("s", 10)]),
      remote: remoteIndex([], { s: 20 }),
      record: recordWith({ s: { updatedAt: 10, contentVersion: 10 } }),
    });

    expect(plan.removals).toEqual(["s"]);
    expect(plan.scenes).toEqual([]);
    expect(plan.uploads).toEqual([]);
  });

  it("resurrects a scene edited here after the remote delete", () => {
    // the delete is just another write: an edit that postdates it wins
    const plan = merge({
      local: localIndex([scene("s", 30)]),
      remote: remoteIndex([], { s: 20 }),
      record: recordWith({ s: { updatedAt: 10, contentVersion: 10 } }),
    });

    expect(plan.removals).toEqual([]);
    expect(ids(plan.scenes)).toEqual(["s"]);
    expect(plan.uploads).toEqual(["s"]);
    expect(plan.remote?.deleted).toEqual({});
  });

  it("resurrects a scene edited elsewhere after this device deleted it", () => {
    const plan = merge({
      local: localIndex([]),
      remote: remoteIndex([scene("s", 30)]),
      record: recordWith({ s: { updatedAt: 10, contentVersion: 10 } }),
    });

    expect(ids(plan.scenes)).toEqual(["s"]);
    expect(plan.scenes[0].materialized).toBe(false);
    expect(plan.remoteRemovals).toEqual([]);
    // the account already says the right thing, so there is nothing to write
    expect(plan.remote).toBeNull();
  });

  it("treats a never-pushed local-only scene as new, not as a deletion", () => {
    // the record is what tells these apart. Without an entry, a scene absent
    // from the remote index has simply never been sent.
    const plan = merge({
      local: localIndex([scene("s", 10)]),
      remote: remoteIndex([]),
    });

    expect(plan.uploads).toEqual(["s"]);
    expect(plan.remoteRemovals).toEqual([]);
  });

  it("prunes tombstones past their TTL", () => {
    const plan = merge({
      local: localIndex([scene("s", 10)]),
      remote: remoteIndex([scene("s", 10)], {
        ancient: NOW - TOMBSTONE_TTL - 1,
        recent: NOW - 1000,
      }),
    });

    expect(plan.remote?.deleted).toEqual({ recent: NOW - 1000 });
  });
});

describe("write avoidance", () => {
  it("skips the remote write when both sides already agree", () => {
    const scenes = [scene("s", 10)];
    const plan = merge({
      local: localIndex(scenes),
      remote: remoteIndex(scenes),
      record: recordWith({ s: { updatedAt: 10, contentVersion: 10 } }),
    });

    // onSnapshot fires for our own writes, so a pass that always wrote would
    // wake every device in a loop
    expect(plan.remote).toBeNull();
    expect(plan.uploads).toEqual([]);
  });

  it("still writes the first time, when there is no remote index at all", () => {
    const plan = merge({ local: localIndex([scene("s", 10)]) });

    expect(plan.remote).not.toBeNull();
    expect(plan.uploads).toEqual(["s"]);
  });

  it("re-uploads a payload the record has no entry for", () => {
    // a lost or cleared record must cost redundant uploads, never silent
    // absence of the payload behind an index entry that claims it exists
    const scenes = [scene("s", 10)];
    const plan = merge({
      local: localIndex(scenes),
      remote: remoteIndex(scenes),
    });

    expect(plan.uploads).toEqual(["s"]);
  });

  it("strips undefined fields, which Firestore rejects outright", () => {
    const plan = merge({
      local: localIndex([scene("s", 10, { contentVersion: undefined })]),
    });

    expect(plan.remote!.scenes[0]).not.toHaveProperty("contentVersion");
    expect(plan.remote!.scenes[0]).not.toHaveProperty("materialized");
  });
});

describe("collections", () => {
  const collection = (id: string, name: string, updatedAt?: number) => ({
    id,
    name,
    createdAt: 1,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  });

  it("keeps the newer rename from either side", () => {
    const plan = merge({
      local: {
        ...localIndex([scene("s", 10)]),
        collections: [collection("c", "local name", 30)],
      },
      remote: {
        ...remoteIndex([scene("s", 10)]),
        collections: [collection("c", "remote name", 20)],
      },
    });

    expect(plan.collections).toEqual([collection("c", "local name", 30)]);
  });

  it("falls back to createdAt for collections written before updatedAt", () => {
    const plan = merge({
      local: {
        ...localIndex([scene("s", 10)]),
        collections: [collection("c", "legacy")],
      },
      remote: {
        ...remoteIndex([scene("s", 10)]),
        collections: [collection("c", "newer", 20)],
      },
    });

    expect(plan.collections[0].name).toBe("newer");
  });

  it("unions collections that exist on only one side", () => {
    const plan = merge({
      local: {
        ...localIndex([scene("s", 10)]),
        collections: [collection("a", "mine", 10)],
      },
      remote: {
        ...remoteIndex([scene("s", 10)]),
        collections: [collection("b", "theirs", 10)],
      },
    });

    expect(plan.collections.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
