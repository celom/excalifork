import { isInputLike } from "@excalidraw/common";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import {
  CloseIcon,
  LoadIcon,
  PlusIcon,
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
  reorderScene,
  switchToScene,
} from "../scenes/actions";
import {
  SCENE_DRAG_MIME,
  getCollections,
  getSceneCollectionId,
} from "../scenes/collections";
import {
  ROOT_COLLECTION_ID,
  scenesIndexAtom,
  openCollectionIdAtom,
} from "../scenes/state";

import { SCENES_SIDEBAR_NAME } from "./AppScenesSidebar";
import { SceneCard } from "./SceneCard";
import { dashboardIcon, folderIcon } from "./ScenesTab";

import "./CollectionDashboard.scss";

import type { SceneId } from "../scenes/storage";

type DropPosition = "before" | "after";

/** maps the pointer's visual half of the card to a document-order position
 * (the grid flows right-to-left in RTL) */
const dropPositionForEvent = (event: React.DragEvent): DropPosition => {
  const rect = event.currentTarget.getBoundingClientRect();
  const inLeftHalf = event.clientX < rect.left + rect.width / 2;
  const isRTL = getComputedStyle(event.currentTarget).direction === "rtl";
  return inLeftHalf !== isRTL ? "before" : "after";
};

export const CollectionDashboard = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const [openCollectionId, setOpenCollectionId] = useAtom(openCollectionIdAtom);
  const scenesIndex = useAtomValue(scenesIndexAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  // the sidebar stacks above the overlay — inset the overlay so its content
  // isn't hidden underneath
  const isScenesSidebarOpen =
    useUIAppState().openSidebar?.name === SCENES_SIDEBAR_NAME;

  const [renamingSceneId, setRenamingSceneId] = useState<SceneId | null>(null);
  const [pendingDeleteSceneId, setPendingDeleteSceneId] =
    useState<SceneId | null>(null);

  // card being dragged for reorder, and where it would land
  const [draggingSceneId, setDraggingSceneId] = useState<SceneId | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    sceneId: SceneId;
    position: DropPosition;
  } | null>(null);

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

  // the dashboard is opened from the scenes sidebar — closing the sidebar
  // takes the overlay with it (on the close transition only, so a dashboard
  // opened by other means isn't affected)
  const wasScenesSidebarOpen = useRef(isScenesSidebarOpen);
  useEffect(() => {
    if (wasScenesSidebarOpen.current && !isScenesSidebarOpen) {
      setOpenCollectionId(null);
    }
    wasScenesSidebarOpen.current = isScenesSidebarOpen;
  }, [isScenesSidebarOpen, setOpenCollectionId]);

  // reset transient edit state when switching collections or closing
  useEffect(() => {
    setRenamingSceneId(null);
    setPendingDeleteSceneId(null);
    setDraggingSceneId(null);
    setDropTarget(null);
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
        if (renamingSceneId) {
          // it also runs before the rename input's own handler — cancel the
          // rename instead of closing the dashboard
          setRenamingSceneId(null);
        } else if (pendingDeleteSceneId) {
          setPendingDeleteSceneId(null);
        } else {
          setOpenCollectionId(null);
        }
      } else if (!isInputLike(event.target)) {
        // the editor stays mounted (and listening for shortcuts on
        // document) beneath the overlay — swallow every other key so
        // Delete, tool hotkeys, arrow nudges etc. can't silently mutate
        // the scene. Keys bound for the rename input must still bubble
        // to React's root listener
        event.stopPropagation();
      }
    };
    // the editor also listens for clipboard events on document (cut
    // deletes the selection!) — swallow those too. stopPropagation
    // doesn't affect native defaults, so copy/paste inside the rename
    // input (or copying selected dashboard text) keeps working
    const onClipboard = (event: ClipboardEvent) => {
      if (!isInputLike(event.target)) {
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("copy", onClipboard, { capture: true });
    window.addEventListener("cut", onClipboard, { capture: true });
    window.addEventListener("paste", onClipboard, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("copy", onClipboard, { capture: true });
      window.removeEventListener("cut", onClipboard, { capture: true });
      window.removeEventListener("paste", onClipboard, { capture: true });
    };
  }, [isOpen, renamingSceneId, pendingDeleteSceneId, setOpenCollectionId]);

  if (!excalidrawAPI || !isOpen || isDangling) {
    return null;
  }

  const pendingDeleteScene = scenesIndex.scenes.find(
    (scene) => scene.id === pendingDeleteSceneId,
  );

  const collectionId =
    openCollectionId === ROOT_COLLECTION_ID ? null : openCollectionId;

  // index order — the user can reorder by dragging; a newly created scene
  // appends last, next to the ghost "New scene" card
  const scenes = scenesIndex.scenes.filter(
    (scene) => getSceneCollectionId(scene, collections) === collectionId,
  );

  const handleCreateScene = () => {
    const meta = createScene(collectionId);
    // let the user name the scene right away on its new card
    setRenamingSceneId(meta.id);
  };

  const draggingIndex = draggingSceneId
    ? scenes.findIndex((scene) => scene.id === draggingSceneId)
    : -1;

  // dropping a card right next to itself would change nothing — don't
  // show an insertion bar there
  const isNoopDrop = (targetIndex: number, position: DropPosition) =>
    draggingIndex !== -1 &&
    (position === "before"
      ? targetIndex === draggingIndex + 1
      : targetIndex === draggingIndex - 1);

  const reorderDropHandlers = (sceneId: SceneId, sceneIndex: number) => ({
    onDragOver: (event: React.DragEvent) => {
      const position = dropPositionForEvent(event);
      if (isNoopDrop(sceneIndex, position)) {
        setDropTarget((current) =>
          current?.sceneId === sceneId ? null : current,
        );
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget((current) =>
        current?.sceneId === sceneId && current.position === position
          ? current
          : { sceneId, position },
      );
    },
    onDragLeave: (event: React.DragEvent) => {
      // ignore transitions into the card's own children
      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
        setDropTarget((current) =>
          current?.sceneId === sceneId ? null : current,
        );
      }
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData(SCENE_DRAG_MIME);
      const position = dropPositionForEvent(event);
      if (draggedId && !isNoopDrop(sceneIndex, position)) {
        reorderScene(draggedId, sceneId, position);
      }
      setDropTarget(null);
      setDraggingSceneId(null);
    },
  });

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
        <div className="collection-dashboard__heading">
          <div className="collection-dashboard__title">
            {collection ? folderIcon : dashboardIcon}
            <span>{collection ? collection.name : "Dashboard"}</span>
          </div>
          <div className="collection-dashboard__subtitle">
            {scenes.length === 1 ? "1 scene" : `${scenes.length} scenes`}
          </div>
        </div>
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
      {scenes.length ? (
        <div className="collection-dashboard__grid">
          {scenes.map((scene, index) => (
            <SceneCard
              key={scene.id}
              meta={scene}
              index={index}
              isActive={scene.id === scenesIndex.activeSceneId}
              disabled={isCollaborating}
              isRenaming={scene.id === renamingSceneId}
              isDragging={scene.id === draggingSceneId}
              dropPosition={
                dropTarget?.sceneId === scene.id ? dropTarget.position : null
              }
              onDragStart={() => setDraggingSceneId(scene.id)}
              onDragEnd={() => {
                setDraggingSceneId(null);
                setDropTarget(null);
              }}
              dropHandlers={
                draggingSceneId && draggingSceneId !== scene.id
                  ? reorderDropHandlers(scene.id, index)
                  : undefined
              }
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
          <button
            type="button"
            className="collection-dashboard__ghost-card"
            style={
              { "--scene-card-index": scenes.length } as React.CSSProperties
            }
            title="Add new scene"
            disabled={isCollaborating}
            onClick={handleCreateScene}
          >
            {PlusIcon}
            <span className="excalifont">New scene</span>
          </button>
        </div>
      ) : (
        <div className="collection-dashboard__empty">
          <div className="collection-dashboard__empty-title excalifont">
            Nothing here yet
          </div>
          <div className="collection-dashboard__empty-hint">
            {collection ? (
              <>
                Create a scene here, or drag one onto <b>{collection.name}</b>{" "}
                in the sidebar.
              </>
            ) : (
              "Create a scene and start sketching."
            )}
          </div>
          <button
            type="button"
            className="collection-dashboard__ghost-card"
            title="Add new scene"
            disabled={isCollaborating}
            onClick={handleCreateScene}
          >
            {PlusIcon}
            <span className="excalifont">New scene</span>
          </button>
        </div>
      )}
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
    </div>
  );
};
