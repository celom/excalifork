/**
 * Firebase transport for per-user scene storage — the only module that knows
 * where a signed-in user's workspace physically lives.
 *
 * Layout (matches the rules in `firebase-project/`):
 *
 *   Firestore  users/{uid}/workspace/index    the scenes index, metadata only
 *   Storage    users/{uid}/scenes/{sceneId}   one gzipped blob per scene
 *   Storage    users/{uid}/files/{fileId}     image files, content-addressed
 *
 * Metadata and payloads are split for two reasons: Firestore documents cap at
 * 1 MiB and scenes have no such bound, and the index is what every device
 * reads on every pass — keeping blobs out of it makes that read cheap and
 * makes `onSnapshot` a viable live-update channel.
 *
 * Nothing here is end-to-end encrypted, unlike collab rooms. A room key rides
 * in the URL fragment the server never sees; a user account has no equivalent
 * secret to derive one from, and there is no Admin SDK key in this project to
 * escrow one with. The security rules (`request.auth.uid == uid`) are the
 * whole boundary — see the "Per-user storage is not end-to-end encrypted"
 * section in `firebase-project/README.md`.
 */

import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  runTransaction,
} from "firebase/firestore";
import {
  deleteObject,
  getBytes,
  getStorage,
  ref,
  uploadBytes,
} from "firebase/storage";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { getFirebaseApp } from "./firebase";

import type { RemoteIndex } from "../scenes/cloudMerge";
import type { SceneData, SceneId } from "../scenes/storage";

/** ~10 MiB — well past any real scene, and a bound on what a corrupt or
 * hostile object can make the tab allocate */
const MAX_BLOB_BYTES = 10 * 1024 * 1024;

const firestoreDb = () => getFirestore(getFirebaseApp());
const storage = () => getStorage(getFirebaseApp());

const indexDoc = (uid: string) =>
  doc(firestoreDb(), "users", uid, "workspace", "index");

const sceneRef = (uid: string, id: SceneId) =>
  ref(storage(), `users/${uid}/scenes/${id}`);

const fileRef = (uid: string, id: FileId) =>
  ref(storage(), `users/${uid}/files/${id}`);

const isNotFound = (error: any) =>
  error?.code === "storage/object-not-found" ||
  error?.code === "storage/unauthorized";

const packJSON = (value: unknown) => gzipSync(strToU8(JSON.stringify(value)));

const unpackJSON = <T>(buffer: ArrayBuffer): T =>
  JSON.parse(strFromU8(gunzipSync(new Uint8Array(buffer))));

/** resolves to null when the object does not exist, throws on anything else */
const getObject = async <T>(
  reference: ReturnType<typeof ref>,
): Promise<T | null> => {
  try {
    return unpackJSON<T>(await getBytes(reference, MAX_BLOB_BYTES));
  } catch (error: any) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
};

const putObject = async (reference: ReturnType<typeof ref>, value: unknown) => {
  await uploadBytes(reference, packJSON(value), {
    contentType: "application/json",
    contentEncoding: "gzip",
  });
};

// -----------------------------------------------------------------------------
// the index document
// -----------------------------------------------------------------------------

export const loadRemoteIndex = async (
  uid: string,
): Promise<RemoteIndex | null> => {
  const snapshot = await getDoc(indexDoc(uid));
  return snapshot.exists() ? (snapshot.data() as RemoteIndex) : null;
};

/**
 * Optimistic concurrency on `updatedAt`: the caller merged against the
 * document it read, so a different `updatedAt` means someone wrote in
 * between and the merge is stale. Rather than clobbering, this hands back
 * what is actually there so the caller can merge again — which is safe to
 * do because merging is idempotent.
 */
export const saveRemoteIndex = async (
  uid: string,
  next: RemoteIndex,
  expectedUpdatedAt: number | null,
): Promise<{ committed: boolean; remote: RemoteIndex | null }> => {
  const db = firestoreDb();
  const reference = doc(db, "users", uid, "workspace", "index");

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists() ? (snapshot.data() as RemoteIndex) : null;

    if ((current?.updatedAt ?? null) !== expectedUpdatedAt) {
      return { committed: false, remote: current };
    }

    transaction.set(reference, next);
    return { committed: true, remote: next };
  });
};

/** live updates from other devices; the callback fires for our own writes
 * too, which is harmless — a pass against an already-merged index is a no-op */
export const subscribeToRemoteIndex = (
  uid: string,
  onChange: () => void,
  onError: (error: any) => void,
) => onSnapshot(indexDoc(uid), () => onChange(), onError);

// -----------------------------------------------------------------------------
// scene payloads
// -----------------------------------------------------------------------------

export const uploadSceneBlob = (uid: string, id: SceneId, data: SceneData) =>
  putObject(sceneRef(uid, id), data);

/** null when the scene has metadata but no payload — a scene created and
 * synced before it was ever drawn on */
export const downloadSceneBlob = (uid: string, id: SceneId) =>
  getObject<SceneData>(sceneRef(uid, id));

/** best-effort: a tombstone that outlives its blob costs storage, not
 * correctness, and the index write is what actually removes the scene */
export const deleteSceneBlob = async (uid: string, id: SceneId) => {
  try {
    await deleteObject(sceneRef(uid, id));
  } catch (error: any) {
    if (!isNotFound(error)) {
      console.warn(error);
    }
  }
};

// -----------------------------------------------------------------------------
// image files
// -----------------------------------------------------------------------------

export const uploadFile = (uid: string, file: BinaryFileData) =>
  putObject(fileRef(uid, file.id), file);

export const downloadFiles = async (uid: string, ids: readonly FileId[]) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      try {
        const file = await getObject<BinaryFileData>(fileRef(uid, id));
        if (file) {
          loadedFiles.push({ ...file, lastRetrieved: Date.now() });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        console.error(error);
        erroredFiles.set(id, true);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
