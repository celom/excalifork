/**
 * Indirection between `applyStoredScene` and whatever can fetch a missing
 * scene payload.
 *
 * A scene can be listed but not held locally (`materialized: false`) — only a
 * cloud pull produces that. Loading one has to download it first, but the
 * loader lives in `actions.ts` and the downloader in `cloudSync.ts`, which
 * itself drives the loader when a remote edit wins for the open scene. A
 * registration point breaks that cycle, and keeps the cloud module out of the
 * import graph of a build with auth switched off.
 */

import type { SceneId } from "./storage";

type SceneMaterializer = (id: SceneId) => Promise<boolean>;

let materializer: SceneMaterializer | null = null;

export const setSceneMaterializer = (fn: SceneMaterializer | null) => {
  materializer = fn;
};

/**
 * Fetches a scene's payload into local storage. Resolves false when nothing
 * can supply it — no sync engine running, or the fetch failed — in which case
 * the scene must stay unrendered rather than load as empty.
 */
export const materializeScene = async (id: SceneId): Promise<boolean> =>
  materializer ? materializer(id) : false;
