/**
 * Collection-level operations (create / rename / delete / assign).
 *
 * Collections are pure index metadata — none of these touch the scene, so
 * there's no collab gating and no save pausing. Persistence and cross-tab
 * notification are handled by `setScenesIndex`'s write-through.
 */

import { getScenesIndex, setScenesIndex } from "./state";
import { newSceneId } from "./storage";

import type {
  CollectionId,
  CollectionMeta,
  SceneId,
  SceneMeta,
  ScenesIndex,
} from "./storage";

/** dataTransfer type for scene drags */
export const SCENE_DRAG_MIME = "application/x-excalidraw-scene-id";

export const getCollections = (index: ScenesIndex): CollectionMeta[] =>
  index.collections ?? [];

/** dangling refs (e.g. collection deleted by another tab) resolve to root */
export const getSceneCollectionId = (
  scene: SceneMeta,
  collections: CollectionMeta[],
): CollectionId | null =>
  scene.collectionId && collections.some((c) => c.id === scene.collectionId)
    ? scene.collectionId
    : null;

const nextCollectionName = (index: ScenesIndex) => {
  const names = new Set(getCollections(index).map((c) => c.name));
  if (!names.has("New collection")) {
    return "New collection";
  }
  let counter = 2;
  while (names.has(`New collection ${counter}`)) {
    counter++;
  }
  return `New collection ${counter}`;
};

/** returns the new meta so the caller can start an inline rename */
export const createCollection = (): CollectionMeta => {
  const index = getScenesIndex();
  const meta: CollectionMeta = {
    id: newSceneId(),
    name: nextCollectionName(index),
    createdAt: Date.now(),
  };
  setScenesIndex({
    ...index,
    collections: [...getCollections(index), meta],
  });
  return meta;
};

export const renameCollection = (id: CollectionId, name: string) => {
  const trimmedName = name.trim();
  const index = getScenesIndex();
  if (!trimmedName || !getCollections(index).some((c) => c.id === id)) {
    return;
  }
  setScenesIndex({
    ...index,
    collections: getCollections(index).map((c) =>
      c.id === id ? { ...c, name: trimmedName } : c,
    ),
  });
};

/** `null` clears the override so the default folder icon renders */
export const setCollectionIcon = (id: CollectionId, icon: string | null) => {
  const index = getScenesIndex();
  if (!getCollections(index).some((c) => c.id === id)) {
    return;
  }
  setScenesIndex({
    ...index,
    collections: getCollections(index).map((c) =>
      c.id === id ? { ...c, icon: icon ?? undefined } : c,
    ),
  });
};

/** contained scenes move back to the root "Dashboard" */
export const deleteCollection = (id: CollectionId) => {
  const index = getScenesIndex();
  if (!getCollections(index).some((c) => c.id === id)) {
    return;
  }
  setScenesIndex({
    ...index,
    collections: getCollections(index).filter((c) => c.id !== id),
    scenes: index.scenes.map((scene) =>
      scene.collectionId === id ? { ...scene, collectionId: null } : scene,
    ),
  });
};

export const assignSceneToCollection = (
  sceneId: SceneId,
  collectionId: CollectionId | null,
) => {
  const index = getScenesIndex();
  const scene = index.scenes.find((d) => d.id === sceneId);
  if (
    !scene ||
    getSceneCollectionId(scene, getCollections(index)) === collectionId ||
    (collectionId !== null &&
      !getCollections(index).some((c) => c.id === collectionId))
  ) {
    return;
  }
  setScenesIndex({
    ...index,
    scenes: index.scenes.map((d) =>
      d.id === sceneId ? { ...d, collectionId } : d,
    ),
  });
};
