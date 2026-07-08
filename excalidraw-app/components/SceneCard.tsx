import {
  DotsHorizontalIcon,
  TrashIcon,
  copyIcon,
  pencilIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { SCENE_DRAG_MIME } from "../scenes/collections";

import { formatRelativeTime, scenesTabIcon } from "./ScenesTab";
import { useScenePreview } from "./useScenePreview";

import type { SceneMeta } from "../scenes/storage";

export const SceneCard = ({
  meta,
  index,
  isActive,
  disabled,
  isRenaming,
  isDragging,
  dropPosition,
  onDragStart,
  onDragEnd,
  dropHandlers,
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
  /** this card is the source of an in-progress reorder drag */
  isDragging: boolean;
  /** side a dragged card would be inserted at, or null */
  dropPosition: "before" | "after" | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** reorder drop-target wiring — only set while another card is dragged */
  dropHandlers?: Pick<
    React.DOMAttributes<HTMLDivElement>,
    "onDragOver" | "onDragLeave" | "onDrop"
  >;
  onOpen: () => void;
  onRenameStart: () => void;
  onRenameCommit: (name: string) => void;
  onDuplicate: () => void;
  onDeleteRequest: () => void;
}) => {
  const { canvasHostRef, status: previewStatus } = useScenePreview(meta);

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

  return (
    <div
      className={clsx("scene-card", {
        "scene-card--active": isActive,
        "scene-card--disabled": disabled,
        "scene-card--dragging": isDragging,
        "scene-card--drop-before": dropPosition === "before",
        "scene-card--drop-after": dropPosition === "after",
      })}
      style={{ "--scene-card-index": index } as React.CSSProperties}
      // dragging interferes with text selection in the rename input
      draggable={!disabled && !isRenaming}
      onDragStart={(event) => {
        event.dataTransfer.setData(SCENE_DRAG_MIME, meta.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      {...dropHandlers}
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
