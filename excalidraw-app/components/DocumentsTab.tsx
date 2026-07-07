import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import {
  PlusIcon,
  TrashIcon,
  copyIcon,
  pencilIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import {
  createDocument,
  deleteDocument,
  duplicateDocument,
  renameDocument,
  switchToDocument,
} from "../documents/actions";
import { documentsIndexAtom } from "../documents/state";

import "./DocumentsTab.scss";

import type { DocumentId } from "../documents/storage";

const MS_IN_MINUTE = 60 * 1000;
const RELATIVE_TIME_UNITS: [number, Intl.RelativeTimeFormatUnit][] = [
  [365 * 24 * 60 * MS_IN_MINUTE, "year"],
  [30 * 24 * 60 * MS_IN_MINUTE, "month"],
  [7 * 24 * 60 * MS_IN_MINUTE, "week"],
  [24 * 60 * MS_IN_MINUTE, "day"],
  [60 * MS_IN_MINUTE, "hour"],
  [MS_IN_MINUTE, "minute"],
];

const formatRelativeTime = (timestamp: number) => {
  const diff = timestamp - Date.now();
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unitMs, unit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diff) >= unitMs) {
      return formatter.format(Math.round(diff / unitMs), unit);
    }
  }
  return "just now";
};

export const DocumentsTab = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const documentsIndex = useAtomValue(documentsIndexAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);

  const [renamingId, setRenamingId] = useState<DocumentId | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<DocumentId | null>(
    null,
  );

  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  if (!excalidrawAPI) {
    return null;
  }

  const documents = [...documentsIndex.documents].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const pendingDeleteDoc = documents.find((doc) => doc.id === pendingDeleteId);

  const startRename = (id: DocumentId, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const commitRename = () => {
    if (renamingId) {
      renameDocument(renamingId, renameValue, excalidrawAPI);
    }
    setRenamingId(null);
  };

  return (
    <div className="documents-tab">
      <div className="documents-tab__header">
        <div className="documents-tab__title">Documents</div>
        <button
          type="button"
          className="documents-tab__new-button"
          onClick={() => createDocument(excalidrawAPI)}
          disabled={isCollaborating}
          title="New document"
        >
          {PlusIcon}
          New
        </button>
      </div>
      {isCollaborating && (
        <div className="documents-tab__hint">
          Switching documents is disabled during a live collaboration session.
        </div>
      )}
      <div className="documents-tab__list">
        {documents.map((doc) => {
          const isActive = doc.id === documentsIndex.activeDocumentId;
          const isRenaming = doc.id === renamingId;
          const switchDisabled = isCollaborating || isActive;
          return (
            <div
              key={doc.id}
              className={clsx("documents-tab__item", {
                "documents-tab__item--active": isActive,
                "documents-tab__item--disabled": isCollaborating && !isActive,
              })}
              onClick={() => {
                if (!switchDisabled && !isRenaming) {
                  switchToDocument(doc.id, excalidrawAPI);
                }
              }}
            >
              <div className="documents-tab__item-info">
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    className="documents-tab__rename-input"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitRename();
                      } else if (event.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                  />
                ) : (
                  <div className="documents-tab__item-name">
                    {isActive && (
                      <span
                        className="documents-tab__active-dot"
                        title="Active document"
                      />
                    )}
                    {doc.name}
                  </div>
                )}
                <div className="documents-tab__item-time">
                  {formatRelativeTime(doc.updatedAt)}
                </div>
              </div>
              <div className="documents-tab__item-actions">
                <button
                  type="button"
                  title="Rename"
                  onClick={(event) => {
                    event.stopPropagation();
                    startRename(doc.id, doc.name);
                  }}
                >
                  {pencilIcon}
                </button>
                <button
                  type="button"
                  title="Duplicate"
                  onClick={(event) => {
                    event.stopPropagation();
                    duplicateDocument(doc.id);
                  }}
                >
                  {copyIcon}
                </button>
                <button
                  type="button"
                  title="Delete"
                  disabled={isActive && isCollaborating}
                  onClick={(event) => {
                    event.stopPropagation();
                    setPendingDeleteId(doc.id);
                  }}
                >
                  {TrashIcon}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {pendingDeleteDoc && (
        <ConfirmDialog
          title="Delete document"
          onConfirm={() => {
            deleteDocument(pendingDeleteDoc.id, excalidrawAPI);
            setPendingDeleteId(null);
          }}
          onCancel={() => setPendingDeleteId(null)}
        >
          <p>
            Are you sure you want to delete <b>{pendingDeleteDoc.name}</b>? This
            cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
};

// tabler-icons: files (no fitting icon in the editor package)
export const documentsTabIcon = (
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
