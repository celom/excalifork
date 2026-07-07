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
import { DOCUMENT_DRAG_MIME } from "../documents/collections";
import { loadDocumentSync } from "../documents/storage";

import { documentsTabIcon } from "./DocumentsTab";

import type { DocumentMeta } from "../documents/storage";

// rendered at 2x for retina
const CARD_PREVIEW_SIZE = 240;
const PREVIEW_PADDING = 8;

export const DocumentCard = ({
  meta,
  isActive,
  disabled,
  isRenaming,
  onOpen,
  onRenameStart,
  onRenameCommit,
  onDuplicate,
  onDeleteRequest,
}: {
  meta: DocumentMeta;
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
      const data = loadDocumentSync(meta.id);
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
        maxWidthOrHeight: CARD_PREVIEW_SIZE * 2,
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
      className={clsx("document-card", {
        "document-card--active": isActive,
        "document-card--disabled": disabled,
      })}
      // dragging interferes with text selection in the rename input
      draggable={!disabled && !isRenaming}
      onDragStart={(event) => {
        event.dataTransfer.setData(DOCUMENT_DRAG_MIME, meta.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => {
        if (!disabled && !isRenaming) {
          onOpen();
        }
      }}
    >
      <div className="document-card__preview">
        <div
          ref={canvasHostRef}
          className={clsx("document-card__preview-canvas", {
            "document-card__preview-canvas--hidden": previewStatus !== "ready",
          })}
        />
        {previewStatus === "empty" && (
          <div className="document-card__preview-fallback">Empty</div>
        )}
        {previewStatus === "error" && (
          <div className="document-card__preview-fallback">
            {documentsTabIcon}
          </div>
        )}
      </div>
      <div className="document-card__menu-container" ref={menuRef}>
        <button
          type="button"
          className={clsx("document-card__menu-button", {
            "document-card__menu-button--open": isMenuOpen,
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
            className="document-card__menu"
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
              className="document-card__menu-item--danger"
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
      <div className="document-card__name">
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="document-card__rename-input"
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
            {isActive && (
              <span
                className="document-card__active-dot"
                title="Active document"
              />
            )}
            {meta.name}
          </>
        )}
      </div>
    </div>
  );
};
