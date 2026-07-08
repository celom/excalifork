/**
 * Multiple-scene persistence (localStorage PoC).
 *
 * Each scene lives under its own pair of localStorage keys
 * (see `sceneElementsKey` / `sceneAppStateKey`), with a single index key
 * tracking metadata and the active scene.
 *
 * The legacy single-scene keys (`excalidraw` / `excalidraw-state`) are
 * migrated into scene #1 on first load and left in place as backup.
 *
 * The sync helpers are used by hot paths that must stay synchronous
 * (unload-time flush, quota error handling). `scenesStorage` wraps them
 * in an async adapter interface so a remote backend can be swapped in later.
 */

import { isInitializedImageElement } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import {
  STORAGE_KEYS,
  sceneAppStateKey,
  sceneElementsKey,
} from "../app_constants";

export type SceneId = string;

export type CollectionId = string;

export type CollectionMeta = {
  id: CollectionId;
  name: string;
  createdAt: number;
  /** key into COLLECTION_ICONS — missing/unknown renders the default folder */
  icon?: string;
};

export type SceneMeta = {
  id: SceneId;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** missing/null ≡ root "Dashboard" collection */
  collectionId?: CollectionId | null;
};

export type ScenesIndex = {
  version: 1;
  activeSceneId: SceneId;
  scenes: SceneMeta[];
  /** optional — absent on indexes written before collections existed */
  collections?: CollectionMeta[];
};

export type SceneData = {
  elements: ExcalidrawElement[];
  appState: Partial<AppState> | null;
};

export interface ScenesStorageAdapter {
  loadIndex(): Promise<ScenesIndex | null>;
  saveIndex(index: ScenesIndex): Promise<void>;
  loadScene(id: SceneId): Promise<SceneData | null>;
  saveScene(
    id: SceneId,
    data: {
      elements: readonly ExcalidrawElement[];
      appState: Partial<AppState>;
    },
  ): Promise<void>;
  /** removes the scene's data only — the index entry is managed by the
   * caller */
  deleteScene(id: SceneId): Promise<void>;
}

// -----------------------------------------------------------------------------
// sync primitives (localStorage)
// -----------------------------------------------------------------------------

const isValidIndex = (data: any): data is ScenesIndex => {
  return (
    data &&
    data.version === 1 &&
    typeof data.activeSceneId === "string" &&
    Array.isArray(data.scenes) &&
    data.scenes.some((scene: SceneMeta) => scene?.id === data.activeSceneId) &&
    (data.collections === undefined || Array.isArray(data.collections))
  );
};

export const loadIndexSync = (): ScenesIndex | null => {
  try {
    const stored = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_SCENES_INDEX,
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
export const saveIndexSync = (index: ScenesIndex) => {
  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_SCENES_INDEX,
    JSON.stringify(index),
  );
};

export const loadSceneSync = (id: SceneId): SceneData | null => {
  let savedElements = null;
  let savedState = null;
  try {
    savedElements = localStorage.getItem(sceneElementsKey(id));
    savedState = localStorage.getItem(sceneAppStateKey(id));
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
export const saveSceneSync = (
  id: SceneId,
  data: {
    elements: readonly ExcalidrawElement[];
    appState: Partial<AppState>;
  },
) => {
  localStorage.setItem(sceneElementsKey(id), JSON.stringify(data.elements));
  localStorage.setItem(sceneAppStateKey(id), JSON.stringify(data.appState));
};

export const deleteSceneSync = (id: SceneId) => {
  try {
    localStorage.removeItem(sceneElementsKey(id));
    localStorage.removeItem(sceneAppStateKey(id));
  } catch (error: any) {
    console.error(error);
  }
};

// -----------------------------------------------------------------------------
// migration
// -----------------------------------------------------------------------------

export const newSceneId = (): SceneId =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

// fallback identity in case the index cannot be persisted (quota/no storage):
// keeps the generated scene id stable within the session so scene data
// isn't scattered across multiple ids
let inMemoryIndex: ScenesIndex | null = null;

/**
 * One-off migration from the interim "documents" naming: moves the old
 * index (`excalidraw-documents`) and per-document scene keys
 * (`excalidraw-doc-*:<id>`) to their "scenes" equivalents. Unlike the
 * legacy single-scene keys, the old keys are removed after copying —
 * they were never a released format worth keeping as backup.
 */
const migrateDocumentsIndex = (): ScenesIndex | null => {
  try {
    const stored = localStorage.getItem("excalidraw-documents");
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored);
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.activeDocumentId !== "string" ||
      !Array.isArray(parsed.documents)
    ) {
      return null;
    }
    for (const meta of parsed.documents as SceneMeta[]) {
      try {
        const elements = localStorage.getItem(
          `excalidraw-doc-elements:${meta.id}`,
        );
        if (elements != null) {
          localStorage.setItem(sceneElementsKey(meta.id), elements);
          localStorage.removeItem(`excalidraw-doc-elements:${meta.id}`);
        }
        const appState = localStorage.getItem(
          `excalidraw-doc-state:${meta.id}`,
        );
        if (appState != null) {
          localStorage.setItem(sceneAppStateKey(meta.id), appState);
          localStorage.removeItem(`excalidraw-doc-state:${meta.id}`);
        }
      } catch (error: any) {
        console.error(error);
      }
    }
    localStorage.removeItem("excalidraw-documents");
    return {
      version: 1,
      activeSceneId: parsed.activeDocumentId,
      scenes: parsed.documents,
      ...(Array.isArray(parsed.collections)
        ? { collections: parsed.collections }
        : {}),
    };
  } catch (error: any) {
    console.error(error);
    return null;
  }
};

const createInitialIndex = (): ScenesIndex => {
  const id = newSceneId();

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
      localStorage.setItem(sceneElementsKey(id), legacyElements);
    }
    if (legacyState != null) {
      localStorage.setItem(sceneAppStateKey(id), legacyState);
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
    activeSceneId: id,
    scenes: [{ id, name, createdAt: now, updatedAt: now }],
  };
};

/**
 * Returns the scenes index, migrating an interim "documents" index or the
 * legacy single scene (into scene #1) on first call. Idempotent — keyed on
 * index existence.
 */
export const getOrCreateScenesIndex = (): ScenesIndex => {
  const stored = loadIndexSync();
  if (stored) {
    inMemoryIndex = stored;
    return stored;
  }
  const migrated = migrateDocumentsIndex();
  if (migrated) {
    inMemoryIndex = migrated;
    try {
      saveIndexSync(migrated);
    } catch (error: any) {
      console.error(error);
    }
    return migrated;
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

/** collects image fileIds referenced by any scene — used so the image GC
 * doesn't delete files that are only used by inactive scenes */
export const getAllSceneFileIds = (): FileId[] => {
  const fileIds = new Set<FileId>();
  const index = loadIndexSync();
  if (!index) {
    return [];
  }
  for (const meta of index.scenes) {
    try {
      const savedElements = localStorage.getItem(sceneElementsKey(meta.id));
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

class LocalStorageScenesAdapter implements ScenesStorageAdapter {
  async loadIndex() {
    return loadIndexSync();
  }
  async saveIndex(index: ScenesIndex) {
    saveIndexSync(index);
  }
  async loadScene(id: SceneId) {
    return loadSceneSync(id);
  }
  async saveScene(
    id: SceneId,
    data: {
      elements: readonly ExcalidrawElement[];
      appState: Partial<AppState>;
    },
  ) {
    saveSceneSync(id, data);
  }
  async deleteScene(id: SceneId) {
    deleteSceneSync(id);
  }
}

export const scenesStorage: ScenesStorageAdapter =
  new LocalStorageScenesAdapter();
