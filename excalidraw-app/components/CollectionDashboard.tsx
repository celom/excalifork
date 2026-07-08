import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import {
  CloseIcon,
  LoadIcon,
  PlusIcon,
  TrashIcon,
  pencilIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { useAtom, useAtomValue } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import { LocalData } from "../data/LocalData";
import {
  createScene,
  deleteScene,
  duplicateScene,
  importScene,
  renameScene,
  switchToScene,
} from "../scenes/actions";
import {
  deleteCollection,
  getCollections,
  getSceneCollectionId,
  renameCollection,
} from "../scenes/collections";
import {
  ROOT_COLLECTION_ID,
  scenesIndexAtom,
  openCollectionIdAtom,
} from "../scenes/state";

import { SCENES_SIDEBAR_NAME } from "./AppScenesSidebar";
import { SceneCard } from "./SceneCard";

import "./CollectionDashboard.scss";

import type { SceneId } from "../scenes/storage";

export const CollectionDashboard = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const [openCollectionId, setOpenCollectionId] = useAtom(openCollectionIdAtom);
  const scenesIndex = useAtomValue(scenesIndexAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  // the sidebar stacks above the overlay — inset the overlay so its content
  // isn't hidden underneath
  const isScenesSidebarOpen =
    useUIAppState().openSidebar?.name === SCENES_SIDEBAR_NAME;

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isPendingDelete, setIsPendingDelete] = useState(false);

  const [renamingSceneId, setRenamingSceneId] = useState<SceneId | null>(null);
  const [pendingDeleteSceneId, setPendingDeleteSceneId] =
    useState<SceneId | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const isOpen = openCollectionId !== null;
  const collections = getCollections(scenesIndex);
  const collection =
    openCollectionId !== null && openCollectionId !== ROOT_COLLECTION_ID
      ? collections.find((c) => c.id === openCollectionId)
      : null;
  // the open collection was deleted (possibly by another tab)
  const isDangling = openCollectionId !== ROOT_COLLECTION_ID && !collection;

  useEffect(() => {
    if (isOpen && isDangling) {
      setOpenCollectionId(null);
    }
  }, [isOpen, isDangling, setOpenCollectionId]);

  // reset transient edit state when switching collections or closing
  useEffect(() => {
    setIsRenaming(false);
    setIsPendingDelete(false);
    setRenamingSceneId(null);
    setPendingDeleteSceneId(null);
  }, [openCollectionId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // persist the active scene's pending debounced save so its card
    // snapshot is up to date
    LocalData.flushSave();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // capture on window runs before the editor's scene-level handler,
        // so the canvas doesn't also react
        event.stopPropagation();
        if (isRenaming) {
          // it also runs before the rename input's own handler — cancel the
          // rename instead of closing the dashboard
          setIsRenaming(false);
        } else if (renamingSceneId) {
          setRenamingSceneId(null);
        } else if (isPendingDelete) {
          setIsPendingDelete(false);
        } else if (pendingDeleteSceneId) {
          setPendingDeleteSceneId(null);
        } else {
          setOpenCollectionId(null);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [
    isOpen,
    isRenaming,
    isPendingDelete,
    renamingSceneId,
    pendingDeleteSceneId,
    setOpenCollectionId,
  ]);

  if (!excalidrawAPI || !isOpen || isDangling) {
    return null;
  }

  const commitRename = () => {
    if (collection) {
      renameCollection(collection.id, renameValue);
    }
    setIsRenaming(false);
  };

  const pendingDeleteScene = scenesIndex.scenes.find(
    (scene) => scene.id === pendingDeleteSceneId,
  );

  const collectionId =
    openCollectionId === ROOT_COLLECTION_ID ? null : openCollectionId;

  const scenes = scenesIndex.scenes
    .filter(
      (scene) => getSceneCollectionId(scene, collections) === collectionId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div
      className={clsx("collection-dashboard", {
        "collection-dashboard--sidebar-open": isScenesSidebarOpen,
      })}
      // keep the (undocked) scenes sidebar open while interacting with
      // the dashboard — also avoids the layout shift swallowing the click
      data-prevent-outside-click
    >
      <div className="collection-dashboard__header">
        {collection && isRenaming ? (
          <input
            ref={renameInputRef}
            className="collection-dashboard__rename-input"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitRename();
              }
            }}
          />
        ) : (
          <div className="collection-dashboard__title">
            {collection ? collection.name : "Dashboard"}
          </div>
        )}
        <div className="collection-dashboard__header-actions">
          <button
            type="button"
            className="collection-dashboard__button collection-dashboard__button--secondary"
            title="Import an .excalidraw file as a new scene"
            disabled={isCollaborating}
            onClick={async () => {
              const imported = await importScene(excalidrawAPI, collectionId);
              if (imported) {
                setOpenCollectionId(null);
              }
            }}
          >
            {LoadIcon}
            Import scene
          </button>
          <button
            type="button"
            className="collection-dashboard__button"
            title="Add new scene"
            disabled={isCollaborating}
            onClick={() => {
              const meta = createScene(collectionId);
              // let the user name the scene right away on its new card
              setRenamingSceneId(meta.id);
            }}
          >
            {PlusIcon}
            New scene
          </button>
          {collection && !isRenaming && (
            <>
              <button
                type="button"
                className="collection-dashboard__action"
                title="Rename collection"
                onClick={() => {
                  setRenameValue(collection.name);
                  setIsRenaming(true);
                }}
              >
                {pencilIcon}
              </button>
              <button
                type="button"
                className="collection-dashboard__action"
                title="Delete collection"
                onClick={() => setIsPendingDelete(true)}
              >
                {TrashIcon}
              </button>
            </>
          )}
          <button
            type="button"
            className="collection-dashboard__close"
            title="Close"
            onClick={() => setOpenCollectionId(null)}
          >
            {CloseIcon}
          </button>
        </div>
      </div>
      {isCollaborating && (
        <div className="collection-dashboard__hint">
          Switching scenes is disabled during a live collaboration session.
        </div>
      )}
      <div className="collection-dashboard__grid">
        {scenes.map((scene) => (
          <SceneCard
            key={scene.id}
            meta={scene}
            isActive={scene.id === scenesIndex.activeSceneId}
            disabled={isCollaborating}
            isRenaming={scene.id === renamingSceneId}
            onOpen={() => {
              switchToScene(scene.id, excalidrawAPI);
              setOpenCollectionId(null);
            }}
            onRenameStart={() => setRenamingSceneId(scene.id)}
            onRenameCommit={(name) => {
              renameScene(scene.id, name, excalidrawAPI);
              setRenamingSceneId(null);
            }}
            onDuplicate={() => duplicateScene(scene.id)}
            onDeleteRequest={() => setPendingDeleteSceneId(scene.id)}
          />
        ))}
        {!scenes.length && (
          <div className="collection-dashboard__empty">
            No scenes in this collection.
          </div>
        )}
      </div>
      {pendingDeleteScene && (
        <ConfirmDialog
          title="Delete scene"
          onConfirm={() => {
            deleteScene(pendingDeleteScene.id, excalidrawAPI);
            setPendingDeleteSceneId(null);
          }}
          onCancel={() => setPendingDeleteSceneId(null)}
        >
          <p>
            Are you sure you want to delete <b>{pendingDeleteScene.name}</b>?
            This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
      {isPendingDelete && collection && (
        <ConfirmDialog
          title="Delete collection"
          onConfirm={() => {
            deleteCollection(collection.id);
            setIsPendingDelete(false);
            setOpenCollectionId(null);
          }}
          onCancel={() => setIsPendingDelete(false)}
        >
          <p>
            Are you sure you want to delete <b>{collection.name}</b>? Its scenes
            will move back to Dashboard.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
};
