import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import { Popover } from "@excalidraw/excalidraw/components/Popover";
import {
  PlusIcon,
  TrashIcon,
  pencilIcon,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useState } from "react";

import { useAtom, useAtomValue } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import { LocalData } from "../data/LocalData";
import { switchToScene } from "../scenes/actions";
import {
  COLLECTION_DRAG_MIME,
  SCENE_DRAG_MIME,
  assignSceneToCollection,
  createCollection,
  deleteCollection,
  getCollections,
  getSceneCollectionId,
  renameCollection,
  reorderCollection,
  setCollectionIcon,
} from "../scenes/collections";
import { searchScenes } from "../scenes/search";
import {
  ROOT_COLLECTION_ID,
  ROOT_COLLECTION_NAME,
  SCENES_SIDEBAR_NAME,
  scenesIndexAtom,
  openCollectionIdAtom,
  scenesSidebarPinnedAtom,
} from "../scenes/state";

import {
  COLLECTION_ICONS,
  DEFAULT_COLLECTION_ICON,
  getCollectionIcon,
} from "./collectionIcons";
import { SceneDestinations } from "./SceneDestinations";
import { useScenePreview } from "./useScenePreview";

import "./ScenesTab.scss";

import type { SceneMeta } from "../scenes/storage";
import type { OpenCollectionId } from "../scenes/state";

const MS_IN_MINUTE = 60 * 1000;
const RELATIVE_TIME_UNITS: [number, Intl.RelativeTimeFormatUnit][] = [
  [365 * 24 * 60 * MS_IN_MINUTE, "year"],
  [30 * 24 * 60 * MS_IN_MINUTE, "month"],
  [7 * 24 * 60 * MS_IN_MINUTE, "week"],
  [24 * 60 * MS_IN_MINUTE, "day"],
  [60 * MS_IN_MINUTE, "hour"],
  [MS_IN_MINUTE, "minute"],
];

export const formatRelativeTime = (timestamp: number) => {
  const diff = timestamp - Date.now();
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unitMs, unit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diff) >= unitMs) {
      return formatter.format(Math.round(diff / unitMs), unit);
    }
  }
  return "just now";
};

type DropPosition = "before" | "after";

/** the collection list is a vertical stack — the pointer's half of the row
 * picks the insertion side */
const dropPositionForEvent = (event: React.DragEvent): DropPosition => {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
};

const SearchResultThumbnail = ({ meta }: { meta: SceneMeta }) => {
  const { canvasHostRef, status } = useScenePreview(meta);
  return (
    <div className="scenes-tab__item-thumb">
      <div
        ref={canvasHostRef}
        className={clsx("scenes-tab__item-thumb-canvas", {
          "scenes-tab__item-thumb-canvas--hidden": status !== "ready",
        })}
      />
      {status !== "ready" && scenesTabIcon}
    </div>
  );
};

export const ScenesTab = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const scenesIndex = useAtomValue(scenesIndexAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  const isSidebarPinned = useAtomValue(scenesSidebarPinnedAtom);
  const [openCollectionId, setOpenCollectionId] = useAtom(openCollectionIdAtom);

  const [dropTargetId, setDropTargetId] = useState<OpenCollectionId | null>(
    null,
  );
  // row being dragged for reorder, and where it would land
  const [draggingCollectionId, setDraggingCollectionId] = useState<
    string | null
  >(null);
  const [reorderTarget, setReorderTarget] = useState<{
    collectionId: string;
    position: DropPosition;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [renamingCollectionId, setRenamingCollectionId] = useState<
    string | null
  >(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDeleteCollectionId, setPendingDeleteCollectionId] = useState<
    string | null
  >(null);
  const [iconPicker, setIconPicker] = useState<{
    collectionId: string;
    top: number;
    left: number;
  } | null>(null);

  if (!excalidrawAPI) {
    return null;
  }

  // index order — the user can reorder by dragging; a newly created
  // collection appends last
  const collections = getCollections(scenesIndex);

  const sceneCounts = new Map<OpenCollectionId, number>();
  for (const scene of scenesIndex.scenes) {
    const key = getSceneCollectionId(scene, collections) ?? ROOT_COLLECTION_ID;
    sceneCounts.set(key, (sceneCounts.get(key) ?? 0) + 1);
  }

  const pendingDeleteCollection = collections.find(
    (collection) => collection.id === pendingDeleteCollectionId,
  );

  const commitRename = (collectionId: string) => {
    renameCollection(collectionId, renameValue);
    setRenamingCollectionId(null);
  };

  const isSearching = Boolean(searchQuery.trim());
  const searchResults = isSearching
    ? searchScenes(scenesIndex, searchQuery)
    : [];

  const draggingIndex = draggingCollectionId
    ? collections.findIndex(
        (collection) => collection.id === draggingCollectionId,
      )
    : -1;

  // dropping a row right next to itself would change nothing — don't show an
  // insertion bar there
  const isNoopDrop = (targetIndex: number, position: DropPosition) =>
    draggingIndex !== -1 &&
    (position === "before"
      ? targetIndex === draggingIndex + 1
      : targetIndex === draggingIndex - 1);

  const clearReorderTarget = (collectionId: string) =>
    setReorderTarget((current) =>
      current?.collectionId === collectionId ? null : current,
    );

  /** reorder drop-target wiring; only used while a row is being dragged */
  const reorderDropHandlers = (
    collectionId: string,
    collectionIndex: number,
  ) => ({
    onDragOver: (event: React.DragEvent) => {
      const position = dropPositionForEvent(event);
      if (isNoopDrop(collectionIndex, position)) {
        clearReorderTarget(collectionId);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setReorderTarget((current) =>
        current?.collectionId === collectionId && current.position === position
          ? current
          : { collectionId, position },
      );
    },
    onDragLeave: (event: React.DragEvent) => {
      // ignore transitions into the row's own children
      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
        clearReorderTarget(collectionId);
      }
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData(COLLECTION_DRAG_MIME);
      const position = dropPositionForEvent(event);
      if (draggedId && !isNoopDrop(collectionIndex, position)) {
        reorderCollection(draggedId, collectionId, position);
      }
      setReorderTarget(null);
      setDraggingCollectionId(null);
    },
  });

  const collectionDropHandlers = (target: OpenCollectionId) => ({
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes(SCENE_DRAG_MIME)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTargetId(target);
      }
    },
    onDragLeave: (event: React.DragEvent) => {
      // ignore transitions into the row's own children
      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
        setDropTargetId((current) => (current === target ? null : current));
      }
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setDropTargetId(null);
      const sceneId = event.dataTransfer.getData(SCENE_DRAG_MIME);
      if (sceneId) {
        assignSceneToCollection(
          sceneId,
          target === ROOT_COLLECTION_ID ? null : target,
        );
      }
    },
  });

  return (
    <div className="scenes-tab">
      <div className="scenes-tab__search">
        {searchIcon}
        <input
          type="text"
          aria-label="Search scenes"
          placeholder="Search scenes…"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          // make the active scene's latest content searchable
          onFocus={() => LocalData.flushSave()}
        />
      </div>
      {isCollaborating && (
        <div className="scenes-tab__hint">
          Switching scenes is disabled during a live collaboration session.
        </div>
      )}
      {isSearching ? (
        <div className="scenes-tab__list">
          {searchResults.map(({ meta, snippet }) => {
            const isActive = meta.id === scenesIndex.activeSceneId;
            const switchDisabled = isCollaborating || isActive;
            return (
              <div
                key={meta.id}
                className={clsx("scenes-tab__item", {
                  "scenes-tab__item--active": isActive,
                  "scenes-tab__item--disabled": isCollaborating && !isActive,
                })}
                onClick={() => {
                  if (!switchDisabled) {
                    switchToScene(meta.id, excalidrawAPI);
                    // close any open dashboard overlay so the scene is visible
                    setOpenCollectionId(null);
                    if (!isSidebarPinned) {
                      excalidrawAPI.toggleSidebar({
                        name: SCENES_SIDEBAR_NAME,
                        force: false,
                      });
                    }
                  }
                }}
              >
                <SearchResultThumbnail meta={meta} />
                <div className="scenes-tab__item-info">
                  <div className="scenes-tab__item-name">
                    {isActive && (
                      <span
                        className="scenes-tab__active-dot"
                        title="Active scene"
                      />
                    )}
                    {meta.name}
                  </div>
                  {snippet ? (
                    <div className="scenes-tab__item-snippet">{snippet}</div>
                  ) : (
                    <div className="scenes-tab__item-time">
                      {formatRelativeTime(meta.updatedAt)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {!searchResults.length && (
            <div className="scenes-tab__empty">
              <span className="excalifont">No matches</span>
              <span>Nothing found for “{searchQuery.trim()}”.</span>
            </div>
          )}
        </div>
      ) : (
        <>
          <div
            className={clsx("scenes-tab__dashboard", {
              "scenes-tab__dashboard--open":
                openCollectionId === ROOT_COLLECTION_ID,
              "scenes-tab__dashboard--drop-target":
                dropTargetId === ROOT_COLLECTION_ID,
            })}
            onClick={() => setOpenCollectionId(ROOT_COLLECTION_ID)}
            {...collectionDropHandlers(ROOT_COLLECTION_ID)}
          >
            {rootCollectionIcon}
            <span className="scenes-tab__row-label">
              {ROOT_COLLECTION_NAME}
            </span>
            <span className="scenes-tab__row-count">
              {sceneCounts.get(ROOT_COLLECTION_ID) ?? 0}
            </span>
          </div>
          <div className="scenes-tab__section-header">
            Collections
            <button
              type="button"
              title="New collection"
              onClick={() => {
                const meta = createCollection();
                setOpenCollectionId(meta.id);
                // drop the user straight into naming the new collection
                setRenameValue(meta.name);
                setRenamingCollectionId(meta.id);
              }}
            >
              {PlusIcon}
            </button>
          </div>
          <div className="scenes-tab__collections">
            {collections.map((collection, collectionIndex) =>
              collection.id === renamingCollectionId ? (
                <div
                  key={collection.id}
                  className="scenes-tab__collection scenes-tab__collection--renaming"
                >
                  <div className="scenes-tab__collection-name">
                    {getCollectionIcon(collection.icon)}
                    <input
                      className="scenes-tab__rename-input"
                      value={renameValue}
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => commitRename(collection.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          commitRename(collection.id);
                        } else if (event.key === "Escape") {
                          // don't let the editor also react (e.g. close the
                          // sidebar) — just cancel the rename
                          event.stopPropagation();
                          setRenamingCollectionId(null);
                        }
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div
                  key={collection.id}
                  className={clsx("scenes-tab__collection", {
                    "scenes-tab__collection--open":
                      openCollectionId === collection.id,
                    "scenes-tab__collection--drop-target":
                      dropTargetId === collection.id,
                    "scenes-tab__collection--dragging":
                      draggingCollectionId === collection.id,
                    "scenes-tab__collection--drop-before":
                      reorderTarget?.collectionId === collection.id &&
                      reorderTarget.position === "before",
                    "scenes-tab__collection--drop-after":
                      reorderTarget?.collectionId === collection.id &&
                      reorderTarget.position === "after",
                  })}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      COLLECTION_DRAG_MIME,
                      collection.id,
                    );
                    event.dataTransfer.effectAllowed = "move";
                    setDraggingCollectionId(collection.id);
                  }}
                  onDragEnd={() => {
                    setDraggingCollectionId(null);
                    setReorderTarget(null);
                  }}
                  onClick={() => setOpenCollectionId(collection.id)}
                  // a row is either a reorder target (another row is being
                  // dragged) or a scene-assignment target — never both
                  {...(draggingCollectionId
                    ? draggingCollectionId !== collection.id
                      ? reorderDropHandlers(collection.id, collectionIndex)
                      : undefined
                    : collectionDropHandlers(collection.id))}
                >
                  <div className="scenes-tab__collection-name">
                    <button
                      type="button"
                      className="scenes-tab__collection-icon"
                      title="Change icon"
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        setIconPicker({
                          collectionId: collection.id,
                          top: rect.bottom + 4,
                          left: rect.left,
                        });
                      }}
                    >
                      {getCollectionIcon(collection.icon)}
                    </button>
                    <span className="scenes-tab__row-label">
                      {collection.name}
                    </span>
                  </div>
                  <span className="scenes-tab__row-count">
                    {sceneCounts.get(collection.id) ?? 0}
                  </span>
                  <div className="scenes-tab__row-actions">
                    <button
                      type="button"
                      title="Rename collection"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenameValue(collection.name);
                        setRenamingCollectionId(collection.id);
                      }}
                    >
                      {pencilIcon}
                    </button>
                    <button
                      type="button"
                      title="Delete collection"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingDeleteCollectionId(collection.id);
                      }}
                    >
                      {TrashIcon}
                    </button>
                  </div>
                </div>
              ),
            )}
            {!collections.length && (
              <div className="scenes-tab__empty">
                <span className="excalifont">No collections yet</span>
                <span>
                  Create one to group scenes, then drag scenes onto it.
                </span>
              </div>
            )}
          </div>
        </>
      )}
      <SceneDestinations />
      {iconPicker && (
        <Popover
          className="scenes-tab__icon-picker"
          top={iconPicker.top}
          left={iconPicker.left}
          fitInViewport
          onCloseRequest={() => setIconPicker(null)}
        >
          <div
            className="scenes-tab__icon-picker-grid"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // don't let the editor also react (e.g. close the sidebar)
                event.stopPropagation();
                setIconPicker(null);
              }
            }}
          >
            {COLLECTION_ICONS.map(({ key, label, icon }) => (
              <button
                key={key}
                type="button"
                title={label}
                className={clsx("scenes-tab__icon-picker-option", {
                  "scenes-tab__icon-picker-option--active":
                    key ===
                    (collections.find(
                      (collection) => collection.id === iconPicker.collectionId,
                    )?.icon ?? DEFAULT_COLLECTION_ICON),
                })}
                onClick={() => {
                  // the default is stored as "no override" to keep the index
                  // lean and let a future default change apply retroactively
                  setCollectionIcon(
                    iconPicker.collectionId,
                    key === DEFAULT_COLLECTION_ICON ? null : key,
                  );
                  setIconPicker(null);
                }}
              >
                {icon}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {pendingDeleteCollection && (
        <ConfirmDialog
          title="Delete collection"
          onConfirm={() => {
            deleteCollection(pendingDeleteCollection.id);
            setPendingDeleteCollectionId(null);
          }}
          onCancel={() => setPendingDeleteCollectionId(null)}
        >
          <p>
            Are you sure you want to delete{" "}
            <b>{pendingDeleteCollection.name}</b>? Its scenes will move back to{" "}
            <b>{ROOT_COLLECTION_NAME}</b>.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
};

// tabler-icons: files (no fitting icon in the editor package)
export const scenesTabIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 3v4a1 1 0 0 0 1 1h4" />
    <path d="M18 17h-7a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h4l5 5v7a2 2 0 0 1 -2 2z" />
    <path d="M16 17v2a2 2 0 0 1 -2 2h-7a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h2" />
  </svg>
);

/** a ruled pad, the last line trailing off — the root collection's
 * "Scratchpad" (hand-rolled; the editor package has no notepad icon) */
export const rootCollectionIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M7 3 h10 a2 2 0 0 1 2 2 v14 a2 2 0 0 1 -2 2 h-10 a2 2 0 0 1 -2 -2 v-14 a2 2 0 0 1 2 -2 z" />
    <path d="M9 8 h6" />
    <path d="M9 12 h6" />
    <path d="M9 16 h3" />
  </svg>
);
