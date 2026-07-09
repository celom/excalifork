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
  SCENE_DRAG_MIME,
  assignSceneToCollection,
  createCollection,
  deleteCollection,
  getCollections,
  getSceneCollectionId,
  renameCollection,
  setCollectionIcon,
} from "../scenes/collections";
import { searchScenes } from "../scenes/search";
import {
  ROOT_COLLECTION_ID,
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
import { FolderSyncControl } from "./FolderSyncControl";
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

  const collections = [...getCollections(scenesIndex)].sort(
    (a, b) => a.createdAt - b.createdAt,
  );

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
            {dashboardIcon}
            <span className="scenes-tab__row-label">Dashboard</span>
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
            {collections.map((collection) =>
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
                  })}
                  onClick={() => setOpenCollectionId(collection.id)}
                  {...collectionDropHandlers(collection.id)}
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
      <FolderSyncControl />
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
            <b>{pendingDeleteCollection.name}</b>? Its scenes will move back to
            Dashboard.
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

// tabler-icons: layout-dashboard (no fitting icon in the editor package)
export const dashboardIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1" />
    <path d="M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1" />
    <path d="M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1" />
    <path d="M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1" />
  </svg>
);
