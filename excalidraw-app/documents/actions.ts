/**
 * Document-level actions (create / switch / rename / duplicate / delete).
 *
 * Scene swaps follow the collab-join pattern: `resetScene()` (clears scene,
 * store and undo history — undo cannot cross documents) followed by
 * `updateScene({ captureUpdate: NEVER })`.
 */

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
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

import { getDocumentsIndex, setDocumentsIndex } from "./state";
import { documentsStorage, newDocumentId } from "./storage";

import type { DocumentId, DocumentsIndex } from "./storage";

const isCollaborating = () => !!appJotaiStore.get(isCollaboratingAtom);

const nextUntitledName = (index: DocumentsIndex) => {
  const names = new Set(index.documents.map((doc) => doc.name));
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
export const loadDocumentImages = (
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
 * Replaces the scene with the given document's persisted data (load-only —
 * does not touch the index). Also used by cross-tab sync when another tab
 * switched the active document.
 */
export const applyDocumentToScene = async (
  id: DocumentId,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const index = getDocumentsIndex();
  const meta = index.documents.find((doc) => doc.id === id);
  // missing doc keys ≡ empty scene (e.g. a new document before its first save)
  const data = await documentsStorage.loadDocument(id);

  const elements = restoreElements(data?.elements ?? [], null, {
    repairBindings: true,
  });
  const appState = {
    ...restoreAppState(data?.appState ?? null, null),
    // the index is the source of truth for the document name
    name: meta?.name ?? "Untitled",
    // don't let the target document's persisted state slam the sidebar shut
    // while the user is browsing documents
    openSidebar: excalidrawAPI.getAppState().openSidebar,
    isLoading: false,
  };

  excalidrawAPI.resetScene();
  excalidrawAPI.updateScene({
    elements,
    appState,
    captureUpdate: CaptureUpdateAction.NEVER,
  });

  loadDocumentImages(excalidrawAPI, elements);
};

export const switchToDocument = async (
  id: DocumentId,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const index = getDocumentsIndex();
  if (
    id === index.activeDocumentId ||
    !index.documents.some((doc) => doc.id === id) ||
    isCollaborating()
  ) {
    return;
  }

  LocalData.flushSave();
  LocalData.pauseSave("switchingDocument");
  try {
    // re-read — the flush above may have bumped the outgoing doc's meta
    setDocumentsIndex({ ...getDocumentsIndex(), activeDocumentId: id });
    await applyDocumentToScene(id, excalidrawAPI);
  } finally {
    LocalData.resumeSave("switchingDocument");
  }
};

export const createDocument = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  if (isCollaborating()) {
    return;
  }
  const index = getDocumentsIndex();
  const now = Date.now();
  const meta = {
    id: newDocumentId(),
    name: nextUntitledName(index),
    createdAt: now,
    updatedAt: now,
  };

  LocalData.flushSave();
  LocalData.pauseSave("switchingDocument");
  try {
    // re-read — the flush above may have bumped the outgoing doc's meta
    const currentIndex = getDocumentsIndex();
    setDocumentsIndex({
      ...currentIndex,
      activeDocumentId: meta.id,
      documents: [...currentIndex.documents, meta],
    });
    // no doc keys are written until the first onChange — missing keys load
    // as an empty scene
    await applyDocumentToScene(meta.id, excalidrawAPI);
  } finally {
    LocalData.resumeSave("switchingDocument");
  }
};

export const renameDocument = (
  id: DocumentId,
  name: string,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const trimmedName = name.trim();
  const index = getDocumentsIndex();
  if (!trimmedName || !index.documents.some((doc) => doc.id === id)) {
    return;
  }

  setDocumentsIndex({
    ...index,
    documents: index.documents.map((doc) =>
      doc.id === id ? { ...doc, name: trimmedName } : doc,
    ),
  });

  if (id === index.activeDocumentId) {
    excalidrawAPI.updateScene({
      appState: { name: trimmedName },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
};

export const duplicateDocument = async (id: DocumentId) => {
  const index = getDocumentsIndex();
  const sourceMeta = index.documents.find((doc) => doc.id === id);
  if (!sourceMeta) {
    return;
  }

  if (id === index.activeDocumentId) {
    // make sure the copy includes the latest scene
    LocalData.flushSave();
  }

  const data = await documentsStorage.loadDocument(id);
  const newId = newDocumentId();
  if (data) {
    try {
      // images need zero work — content-addressed fileIds in the shared IDB
      // store are shared between documents
      await documentsStorage.saveDocument(newId, {
        elements: data.elements,
        appState: data.appState ?? {},
      });
    } catch (error: any) {
      console.error(error);
      return;
    }
  }

  const now = Date.now();
  const currentIndex = getDocumentsIndex();
  setDocumentsIndex({
    ...currentIndex,
    documents: [
      ...currentIndex.documents,
      {
        id: newId,
        name: `${sourceMeta.name} (copy)`,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
};

export const deleteDocument = async (
  id: DocumentId,
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const index = getDocumentsIndex();
  const docPosition = index.documents.findIndex((doc) => doc.id === id);
  if (docPosition === -1) {
    return;
  }

  if (id !== index.activeDocumentId) {
    setDocumentsIndex({
      ...index,
      documents: index.documents.filter((doc) => doc.id !== id),
    });
    await documentsStorage.deleteDocument(id);
    // orphaned images age out via the 24h rule at next startup
    return;
  }

  if (isCollaborating()) {
    return;
  }

  // drop pending writes of the doc being deleted — don't flush them
  LocalData.cancelSave();

  let documents = index.documents.filter((doc) => doc.id !== id);
  let fallbackId: DocumentId;
  if (documents.length) {
    fallbackId = (
      index.documents[docPosition + 1] ?? index.documents[docPosition - 1]
    ).id;
  } else {
    const now = Date.now();
    const fresh = {
      id: newDocumentId(),
      name: "Untitled",
      createdAt: now,
      updatedAt: now,
    };
    documents = [fresh];
    fallbackId = fresh.id;
  }

  LocalData.pauseSave("switchingDocument");
  try {
    setDocumentsIndex({ ...index, activeDocumentId: fallbackId, documents });
    await documentsStorage.deleteDocument(id);
    await applyDocumentToScene(fallbackId, excalidrawAPI);
  } finally {
    LocalData.resumeSave("switchingDocument");
  }
};
