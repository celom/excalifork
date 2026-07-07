import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { PlusIcon } from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useState } from "react";

import { useAtomValue, useSetAtom } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import { createDocument, switchToDocument } from "../documents/actions";
import {
  DOCUMENT_DRAG_MIME,
  assignDocumentToCollection,
  createCollection,
  getCollections,
} from "../documents/collections";
import {
  ROOT_COLLECTION_ID,
  documentsIndexAtom,
  openCollectionIdAtom,
} from "../documents/state";

import "./DocumentsTab.scss";

import type { OpenCollectionId } from "../documents/state";

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
  const setOpenCollectionId = useSetAtom(openCollectionIdAtom);

  const [dropTargetId, setDropTargetId] = useState<OpenCollectionId | null>(
    null,
  );

  if (!excalidrawAPI) {
    return null;
  }

  const collections = [...getCollections(documentsIndex)].sort(
    (a, b) => a.createdAt - b.createdAt,
  );
  const documents = [...documentsIndex.documents].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  const collectionDropHandlers = (target: OpenCollectionId) => ({
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes(DOCUMENT_DRAG_MIME)) {
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
      const docId = event.dataTransfer.getData(DOCUMENT_DRAG_MIME);
      if (docId) {
        assignDocumentToCollection(
          docId,
          target === ROOT_COLLECTION_ID ? null : target,
        );
      }
    },
  });

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
      <div className="documents-tab__section-header">
        Collections
        <button
          type="button"
          title="New collection"
          onClick={() => {
            const meta = createCollection();
            setOpenCollectionId(meta.id);
          }}
        >
          {PlusIcon}
        </button>
      </div>
      <div className="documents-tab__collections">
        <div
          className={clsx("documents-tab__collection", {
            "documents-tab__collection--drop-target":
              dropTargetId === ROOT_COLLECTION_ID,
          })}
          onClick={() => setOpenCollectionId(ROOT_COLLECTION_ID)}
          {...collectionDropHandlers(ROOT_COLLECTION_ID)}
        >
          <div className="documents-tab__collection-name">
            {folderIcon}
            Dashboard
          </div>
        </div>
        {collections.map((collection) => (
          <div
            key={collection.id}
            className={clsx("documents-tab__collection", {
              "documents-tab__collection--drop-target":
                dropTargetId === collection.id,
            })}
            onClick={() => setOpenCollectionId(collection.id)}
            {...collectionDropHandlers(collection.id)}
          >
            <div className="documents-tab__collection-name">
              {folderIcon}
              {collection.name}
            </div>
          </div>
        ))}
      </div>
      <div className="documents-tab__section-header">All documents</div>
      <div className="documents-tab__list">
        {documents.map((doc) => {
          const isActive = doc.id === documentsIndex.activeDocumentId;
          const switchDisabled = isCollaborating || isActive;
          return (
            <div
              key={doc.id}
              className={clsx("documents-tab__item", {
                "documents-tab__item--active": isActive,
                "documents-tab__item--disabled": isCollaborating && !isActive,
              })}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DOCUMENT_DRAG_MIME, doc.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => {
                if (!switchDisabled) {
                  switchToDocument(doc.id, excalidrawAPI);
                }
              }}
            >
              <div className="documents-tab__item-info">
                <div className="documents-tab__item-name">
                  {isActive && (
                    <span
                      className="documents-tab__active-dot"
                      title="Active document"
                    />
                  )}
                  {doc.name}
                </div>
                <div className="documents-tab__item-time">
                  {formatRelativeTime(doc.updatedAt)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
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

// tabler-icons: folder (no fitting icon in the editor package)
const folderIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />
  </svg>
);
