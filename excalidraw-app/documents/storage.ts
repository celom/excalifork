/**
 * Multiple-document persistence (localStorage PoC).
 *
 * Each document's scene lives under its own pair of localStorage keys
 * (see `docElementsKey` / `docAppStateKey`), with a single index key
 * tracking metadata and the active document.
 *
 * The legacy single-scene keys (`excalidraw` / `excalidraw-state`) are
 * migrated into document #1 on first load and left in place as backup.
 *
 * The sync helpers are used by hot paths that must stay synchronous
 * (unload-time flush, quota error handling). `documentsStorage` wraps them
 * in an async adapter interface so a remote backend can be swapped in later.
 */

import { isInitializedImageElement } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS, docAppStateKey, docElementsKey } from "../app_constants";

export type DocumentId = string;

export type DocumentMeta = {
  id: DocumentId;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type DocumentsIndex = {
  version: 1;
  activeDocumentId: DocumentId;
  documents: DocumentMeta[];
};

export type DocumentData = {
  elements: ExcalidrawElement[];
  appState: Partial<AppState> | null;
};

export interface DocumentsStorageAdapter {
  loadIndex(): Promise<DocumentsIndex | null>;
  saveIndex(index: DocumentsIndex): Promise<void>;
  loadDocument(id: DocumentId): Promise<DocumentData | null>;
  saveDocument(
    id: DocumentId,
    data: {
      elements: readonly ExcalidrawElement[];
      appState: Partial<AppState>;
    },
  ): Promise<void>;
  /** removes the document's data only — the index entry is managed by the
   * caller */
  deleteDocument(id: DocumentId): Promise<void>;
}

// -----------------------------------------------------------------------------
// sync primitives (localStorage)
// -----------------------------------------------------------------------------

const isValidIndex = (data: any): data is DocumentsIndex => {
  return (
    data &&
    data.version === 1 &&
    typeof data.activeDocumentId === "string" &&
    Array.isArray(data.documents) &&
    data.documents.some(
      (doc: DocumentMeta) => doc?.id === data.activeDocumentId,
    )
  );
};

export const loadIndexSync = (): DocumentsIndex | null => {
  try {
    const stored = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_DOCUMENTS_INDEX,
    );
    if (stored) {
      const parsed = JSON.parse(stored);
      if (isValidIndex(parsed)) {
        return parsed;
      }
    }
  } catch (error: any) {
    console.error(error);
  }
  return null;
};

/** throws on quota/storage errors — caller decides how to surface them */
export const saveIndexSync = (index: DocumentsIndex) => {
  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_DOCUMENTS_INDEX,
    JSON.stringify(index),
  );
};

export const loadDocumentSync = (id: DocumentId): DocumentData | null => {
  let savedElements = null;
  let savedState = null;
  try {
    savedElements = localStorage.getItem(docElementsKey(id));
    savedState = localStorage.getItem(docAppStateKey(id));
  } catch (error: any) {
    console.error(error);
  }

  if (savedElements == null && savedState == null) {
    return null;
  }

  let elements: ExcalidrawElement[] = [];
  if (savedElements) {
    try {
      elements = JSON.parse(savedElements);
    } catch (error: any) {
      console.error(error);
    }
  }

  let appState: Partial<AppState> | null = null;
  if (savedState) {
    try {
      appState = JSON.parse(savedState);
    } catch (error: any) {
      console.error(error);
    }
  }

  return { elements, appState };
};

/** throws on quota/storage errors — caller decides how to surface them */
export const saveDocumentSync = (
  id: DocumentId,
  data: {
    elements: readonly ExcalidrawElement[];
    appState: Partial<AppState>;
  },
) => {
  localStorage.setItem(docElementsKey(id), JSON.stringify(data.elements));
  localStorage.setItem(docAppStateKey(id), JSON.stringify(data.appState));
};

export const deleteDocumentSync = (id: DocumentId) => {
  try {
    localStorage.removeItem(docElementsKey(id));
    localStorage.removeItem(docAppStateKey(id));
  } catch (error: any) {
    console.error(error);
  }
};

// -----------------------------------------------------------------------------
// migration
// -----------------------------------------------------------------------------

export const newDocumentId = (): DocumentId =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

// fallback identity in case the index cannot be persisted (quota/no storage):
// keeps the generated document id stable within the session so scene data
// isn't scattered across multiple ids
let inMemoryIndex: DocumentsIndex | null = null;

const createInitialIndex = (): DocumentsIndex => {
  const id = newDocumentId();

  let name = "Untitled";

  try {
    // copy raw strings — no parse/re-serialize of elements, and legacy keys
    // are left in place as backup
    const legacyElements = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
    );
    const legacyState = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
    );
    if (legacyElements != null) {
      localStorage.setItem(docElementsKey(id), legacyElements);
    }
    if (legacyState != null) {
      localStorage.setItem(docAppStateKey(id), legacyState);
      try {
        const parsedState = JSON.parse(legacyState);
        if (typeof parsedState?.name === "string" && parsedState.name) {
          name = parsedState.name;
        }
      } catch (error: any) {
        console.error(error);
      }
    }
  } catch (error: any) {
    console.error(error);
  }

  const now = Date.now();
  return {
    version: 1,
    activeDocumentId: id,
    documents: [{ id, name, createdAt: now, updatedAt: now }],
  };
};

/**
 * Returns the documents index, migrating the legacy single scene into
 * document #1 on first call. Idempotent — keyed on index existence.
 */
export const getOrCreateDocumentsIndex = (): DocumentsIndex => {
  const stored = loadIndexSync();
  if (stored) {
    inMemoryIndex = stored;
    return stored;
  }
  if (inMemoryIndex) {
    return inMemoryIndex;
  }
  const index = createInitialIndex();
  inMemoryIndex = index;
  try {
    saveIndexSync(index);
  } catch (error: any) {
    // persistent write failures surface via the existing quota banner on
    // the scene save path
    console.error(error);
  }
  return index;
};

/** collects image fileIds referenced by any document — used so the image GC
 * doesn't delete files that are only used by inactive documents */
export const getAllDocumentFileIds = (): FileId[] => {
  const fileIds = new Set<FileId>();
  const index = loadIndexSync();
  if (!index) {
    return [];
  }
  for (const meta of index.documents) {
    try {
      const savedElements = localStorage.getItem(docElementsKey(meta.id));
      if (savedElements) {
        const elements: ExcalidrawElement[] = JSON.parse(savedElements);
        for (const element of elements) {
          if (isInitializedImageElement(element)) {
            fileIds.add(element.fileId);
          }
        }
      }
    } catch (error: any) {
      console.error(error);
    }
  }
  return [...fileIds];
};

// -----------------------------------------------------------------------------
// async adapter (future remote backend escape hatch)
// -----------------------------------------------------------------------------

class LocalStorageDocumentsAdapter implements DocumentsStorageAdapter {
  async loadIndex() {
    return loadIndexSync();
  }
  async saveIndex(index: DocumentsIndex) {
    saveIndexSync(index);
  }
  async loadDocument(id: DocumentId) {
    return loadDocumentSync(id);
  }
  async saveDocument(
    id: DocumentId,
    data: {
      elements: readonly ExcalidrawElement[];
      appState: Partial<AppState>;
    },
  ) {
    saveDocumentSync(id, data);
  }
  async deleteDocument(id: DocumentId) {
    deleteDocumentSync(id);
  }
}

export const documentsStorage: DocumentsStorageAdapter =
  new LocalStorageDocumentsAdapter();
