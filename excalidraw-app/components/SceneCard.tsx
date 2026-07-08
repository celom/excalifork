import { THEME } from "@excalidraw/common";
import { exportToCanvas } from "@excalidraw/excalidraw";
import {
  DotsHorizontalIcon,
  TrashIcon,
  copyIcon,
  pencilIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import {
  getCommonBounds,
  isInitializedImageElement,
  newFrameElement,
} from "@excalidraw/element";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import type { FileId } from "@excalidraw/element/types";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { LocalData } from "../data/LocalData";
import { SCENE_DRAG_MIME } from "../scenes/collections";
import { loadSceneSync } from "../scenes/storage";

import { formatRelativeTime, scenesTabIcon } from "./ScenesTab";

import type { SceneMeta } from "../scenes/storage";

// fallback when the preview box can't be measured
const CARD_PREVIEW_SIZE = 240;
const PREVIEW_PADDING = 8;

export const SceneCard = ({
  meta,
  index,
  isActive,
  disabled,
  isRenaming,
  onOpen,
  onRenameStart,
  onRenameCommit,
  onDuplicate,
  onDeleteRequest,
}: {
  meta: SceneMeta;
  /** position in the grid — drives the staggered entrance animation */
  index: number;
  isActive: boolean;
  disabled: boolean;
  isRenaming: boolean;
  onOpen: () => void;
  onRenameStart: () => void;
  onRenameCommit: (name: string) => void;
  onDuplicate: () => void;
  onDeleteRequest: () => void;
}) => {
  const { theme } = useUIAppState();
  // canvas is attached imperatively (replaceChildren) — the host div must
  // stay mounted across status changes and never receive React children
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [previewStatus, setPreviewStatus] = useState<
    "loading" | "ready" | "empty" | "error"
  >("loading");

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isMenuOpen]);

  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    // guards against a stale export resolving after a newer one (or unmount)
    let cancelled = false;
    const isStale = () => cancelled;

    const renderPreview = async () => {
      const data = loadSceneSync(meta.id);
      const elements = data?.elements.filter((element) => !element.isDeleted);
      if (!elements?.length) {
        setPreviewStatus("empty");
        return;
      }

      const fileIds = elements.reduce((acc, element) => {
        if (isInitializedImageElement(element)) {
          acc.push(element.fileId);
        }
        return acc;
      }, [] as FileId[]);

      const files: BinaryFiles = {};
      if (fileIds.length) {
        const { loadedFiles } = await LocalData.fileStorage.getFiles(fileIds);
        if (isStale()) {
          return;
        }
        for (const file of loadedFiles) {
          files[file.id] = file;
        }
      }

      // snapshot a region matching the preview box's aspect ratio (a frame
      // export crops to the exact frame rect), so the canvas background
      // fills the card with no letterboxing
      // (the host itself may be display: none while loading — measure its
      // always-visible parent)
      const box = canvasHostRef.current?.parentElement?.getBoundingClientRect();
      const boxRatio = box?.width && box?.height ? box.width / box.height : 1;
      const [minX, minY, maxX, maxY] = getCommonBounds(elements);
      let width = maxX - minX + PREVIEW_PADDING * 2;
      let height = maxY - minY + PREVIEW_PADDING * 2;
      if (width / height < boxRatio) {
        width = height * boxRatio;
      } else {
        height = width / boxRatio;
      }

      // render at the box's real device-pixel size so the snapshot stays
      // crisp on retina displays and in wide grid cells (maxWidthOrHeight
      // won't do — it only downscales, and the frame is in scene units)
      const targetWidth = Math.ceil(
        (box?.width ?? CARD_PREVIEW_SIZE) * window.devicePixelRatio,
      );

      const canvas = await exportToCanvas({
        elements,
        appState: {
          ...data?.appState,
          exportBackground: true,
          exportWithDarkMode: theme === THEME.DARK,
        },
        files,
        exportingFrame: newFrameElement({
          x: (minX + maxX) / 2 - width / 2,
          y: (minY + maxY) / 2 - height / 2,
          width,
          height,
        }),
        getDimensions: (frameWidth, frameHeight) => {
          const scale = targetWidth / frameWidth;
          return {
            width: targetWidth,
            height: Math.ceil(frameHeight * scale),
            scale,
          };
        },
      });
      if (isStale()) {
        return;
      }
      canvasHostRef.current?.replaceChildren(canvas);
      setPreviewStatus("ready");
    };

    renderPreview().catch((error: any) => {
      console.error(error);
      if (!isStale()) {
        setPreviewStatus("error");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.updatedAt, theme]);

  return (
    <div
      className={clsx("scene-card", {
        "scene-card--active": isActive,
        "scene-card--disabled": disabled,
      })}
      style={{ "--scene-card-index": index } as React.CSSProperties}
      // dragging interferes with text selection in the rename input
      draggable={!disabled && !isRenaming}
      onDragStart={(event) => {
        event.dataTransfer.setData(SCENE_DRAG_MIME, meta.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => {
        if (!disabled && !isRenaming) {
          onOpen();
        }
      }}
    >
      <div className="scene-card__preview">
        <div
          ref={canvasHostRef}
          className={clsx("scene-card__preview-canvas", {
            "scene-card__preview-canvas--hidden": previewStatus !== "ready",
          })}
        />
        {previewStatus === "empty" && (
          <div className="scene-card__preview-fallback">Empty</div>
        )}
        {previewStatus === "error" && (
          <div className="scene-card__preview-fallback">{scenesTabIcon}</div>
        )}
      </div>
      <div className="scene-card__menu-container" ref={menuRef}>
        <button
          type="button"
          className={clsx("scene-card__menu-button", {
            "scene-card__menu-button--open": isMenuOpen,
          })}
          title="More actions"
          onClick={(event) => {
            event.stopPropagation();
            setIsMenuOpen((open) => !open);
          }}
        >
          {DotsHorizontalIcon}
        </button>
        {isMenuOpen && (
          <div
            className="scene-card__menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onRenameStart();
              }}
            >
              {pencilIcon}
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onDuplicate();
              }}
            >
              {copyIcon}
              Duplicate
            </button>
            <button
              type="button"
              className="scene-card__menu-item--danger"
              disabled={isActive && disabled}
              onClick={() => {
                setIsMenuOpen(false);
                onDeleteRequest();
              }}
            >
              {TrashIcon}
              Delete
            </button>
          </div>
        )}
      </div>
      <div className="scene-card__footer">
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="scene-card__rename-input"
            defaultValue={meta.name}
            onClick={(event) => event.stopPropagation()}
            onBlur={() =>
              onRenameCommit(renameInputRef.current?.value ?? meta.name)
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onRenameCommit(renameInputRef.current?.value ?? meta.name);
              }
            }}
          />
        ) : (
          <>
            <div className="scene-card__name">
              {isActive && (
                <span className="scene-card__active-dot" title="Active scene" />
              )}
              {meta.name}
            </div>
            <div className="scene-card__time">
              {formatRelativeTime(meta.updatedAt)}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
