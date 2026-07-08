/**
 * Scene-level actions (create / switch / rename / duplicate / delete).
 *
 * Scene swaps follow the collab-join pattern: `resetScene()` (clears scene,
 * store and undo history — undo cannot cross scenes) followed by
 * `updateScene({ captureUpdate: NEVER })`.
 */

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { fileOpen } from "@excalidraw/excalidraw/data/filesystem";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { isInitializedImageElement } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import { updateStaleImageStatuses } from "../data/FileManager";
import { LocalData } from "../data/LocalData";

import { getScenesIndex, setScenesIndex } from "./state";
import { scenesStorage, newSceneId } from "./storage";

import type { CollectionId, SceneId, SceneMeta, ScenesIndex } from "./storage";

const isCollaborating = () => !!appJotaiStore.get(isCollaboratingAtom);

const nextUntitledName = (index: ScenesIndex) => {
  const names = new Set(index.scenes.map((scene) => scene.name));
  if (!names.has("Untitled")) {
    return "Untitled";
  }
  let counter = 2;
  while (names.has(`Untitled ${counter}`)) {
    counter++;
  }
  return `Untitled ${counter}`;
};

/** loads the given elements' image files from local IDB into the scene */
export const loadSceneImages = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
) => {
  const fileIds = elements.reduce((acc, element) => {
    if (isInitializedImageElement(element)) {
      acc.push(element.fileId);
    }
    return acc;
  }, [] as FileId[]);

  if (!fileIds.length) {
    return;
  }

  LocalData.fileStorage
    .getFiles(fileIds)
    .then(({ loadedFiles, erroredFiles }) => {
      if (loadedFiles.length) {
        excalidrawAPI.addFiles(loadedFiles);
      }
      updateStaleImageStatuses({
        excalidrawAPI,
        erroredFiles,
        elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
      });
    });
};

/**
 * Replaces the scene with the given scene's persisted data (load-only —
 * does not touch the index). Also used by cross-tab sync when another tab
 * switched the active scene.
 */
export const applyStoredScene = async (
  id: SceneId,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const index = getScenesIndex();
  const meta = index.scenes.find((scene) => scene.id === id);
  // missing scene keys ≡ empty scene (e.g. a new scene before its first save)
  const data = await scenesStorage.loadScene(id);

  const elements = restoreElements(data?.elements ?? [], null, {
    repairBindings: true,
  });
  const appState = {
    ...restoreAppState(data?.appState ?? null, null),
    // the index is the source of truth for the scene name
    name: meta?.name ?? "Untitled",
    // don't let the target scene's persisted state slam the sidebar shut
    // while the user is browsing scenes
    openSidebar: excalidrawAPI.getAppState().openSidebar,
    isLoading: false,
  };

  excalidrawAPI.resetScene();
  excalidrawAPI.updateScene({
    elements,
    appState,
    captureUpdate: CaptureUpdateAction.NEVER,
  });

  loadSceneImages(excalidrawAPI, elements);
};

export const switchToScene = async (
  id: SceneId,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const index = getScenesIndex();
  if (
    id === index.activeSceneId ||
    !index.scenes.some((scene) => scene.id === id) ||
    isCollaborating()
  ) {
    return;
  }

  LocalData.flushSave();
  LocalData.pauseSave("switchingScene");
  try {
    // re-read — the flush above may have bumped the outgoing scene's meta
    setScenesIndex({ ...getScenesIndex(), activeSceneId: id });
    await applyStoredScene(id, excalidrawAPI);
  } finally {
    LocalData.resumeSave("switchingScene");
  }
};

/**
 * Adds a new empty scene to the index without switching to it — a pure
 * index operation, so no collab gating and no save pausing. Returns the
 * new meta so the caller can start an inline rename.
 */
export const createScene = (
  collectionId: CollectionId | null = null,
): SceneMeta => {
  const index = getScenesIndex();
  const now = Date.now();
  const meta: SceneMeta = {
    id: newSceneId(),
    name: nextUntitledName(index),
    createdAt: now,
    updatedAt: now,
    collectionId,
  };
  // no scene keys are written until the scene is opened and first edited —
  // missing keys load as an empty scene
  setScenesIndex({ ...index, scenes: [...index.scenes, meta] });
  return meta;
};

/**
 * Imports an .excalidraw file as a new scene and switches to it.
 * Returns the new scene's id, or null if the user cancelled the file picker.
 */
export const importScene = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  collectionId: CollectionId | null = null,
): Promise<SceneId | null> => {
  if (isCollaborating()) {
    return null;
  }

  let file: File;
  try {
    file = await fileOpen({
      description: "Excalidraw files",
      extensions: ["excalidraw"],
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      return null;
    }
    throw error;
  }

  const data = await loadFromBlob(file, null, null);

  const id = newSceneId();
  // embedded images go into the shared IDB files store, same as images
  // added while drawing
  if (data.files && Object.keys(data.files).length) {
    await LocalData.fileStorage.saveFiles({
      elements: data.elements,
      files: data.files,
    });
  }
  await scenesStorage.saveScene(id, {
    elements: data.elements,
    appState: clearAppStateForLocalStorage(data.appState),
  });

  const name =
    data.appState.name?.trim() ||
    file.name.replace(/\.excalidraw$/i, "").trim() ||
    "Untitled";

  LocalData.flushSave();
  LocalData.pauseSave("switchingScene");
  try {
    // re-read — the flush above may have bumped the outgoing scene's meta
    const currentIndex = getScenesIndex();
    const now = Date.now();
    setScenesIndex({
      ...currentIndex,
      activeSceneId: id,
      scenes: [
        ...currentIndex.scenes,
        { id, name, createdAt: now, updatedAt: now, collectionId },
      ],
    });
    await applyStoredScene(id, excalidrawAPI);
  } finally {
    LocalData.resumeSave("switchingScene");
  }
  return id;
};

export const renameScene = (
  id: SceneId,
  name: string,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const trimmedName = name.trim();
  const index = getScenesIndex();
  if (!trimmedName || !index.scenes.some((scene) => scene.id === id)) {
    return;
  }

  setScenesIndex({
    ...index,
    scenes: index.scenes.map((scene) =>
      scene.id === id ? { ...scene, name: trimmedName } : scene,
    ),
  });

  if (id === index.activeSceneId) {
    excalidrawAPI.updateScene({
      appState: { name: trimmedName },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
};

export const duplicateScene = async (id: SceneId) => {
  const index = getScenesIndex();
  const sourceMeta = index.scenes.find((scene) => scene.id === id);
  if (!sourceMeta) {
    return;
  }

  if (id === index.activeSceneId) {
    // make sure the copy includes the latest scene
    LocalData.flushSave();
  }

  const data = await scenesStorage.loadScene(id);
  const newId = newSceneId();
  if (data) {
    try {
      // images need zero work — content-addressed fileIds in the shared IDB
      // store are shared between scenes
      await scenesStorage.saveScene(newId, {
        elements: data.elements,
        appState: data.appState ?? {},
      });
    } catch (error: any) {
      console.error(error);
      return;
    }
  }

  const now = Date.now();
  const currentIndex = getScenesIndex();
  setScenesIndex({
    ...currentIndex,
    scenes: [
      ...currentIndex.scenes,
      {
        id: newId,
        name: `${sourceMeta.name} (copy)`,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
};

export const deleteScene = async (
  id: SceneId,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const index = getScenesIndex();
  const scenePosition = index.scenes.findIndex((scene) => scene.id === id);
  if (scenePosition === -1) {
    return;
  }

  if (id !== index.activeSceneId) {
    setScenesIndex({
      ...index,
      scenes: index.scenes.filter((scene) => scene.id !== id),
    });
    await scenesStorage.deleteScene(id);
    // orphaned images age out via the 24h rule at next startup
    return;
  }

  if (isCollaborating()) {
    return;
  }

  // drop pending writes of the scene being deleted — don't flush them
  LocalData.cancelSave();

  let scenes = index.scenes.filter((scene) => scene.id !== id);
  let fallbackId: SceneId;
  if (scenes.length) {
    fallbackId = (
      index.scenes[scenePosition + 1] ?? index.scenes[scenePosition - 1]
    ).id;
  } else {
    const now = Date.now();
    const fresh = {
      id: newSceneId(),
      name: "Untitled",
      createdAt: now,
      updatedAt: now,
    };
    scenes = [fresh];
    fallbackId = fresh.id;
  }

  LocalData.pauseSave("switchingScene");
  try {
    setScenesIndex({ ...index, activeSceneId: fallbackId, scenes });
    await scenesStorage.deleteScene(id);
    await applyStoredScene(fallbackId, excalidrawAPI);
  } finally {
    LocalData.resumeSave("switchingScene");
  }
};
