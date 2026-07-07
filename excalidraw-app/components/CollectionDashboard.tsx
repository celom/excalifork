import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import {
  CloseIcon,
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
  deleteDocument,
  duplicateDocument,
  renameDocument,
  switchToDocument,
} from "../documents/actions";
import {
  deleteCollection,
  getCollections,
  getDocumentCollectionId,
  renameCollection,
} from "../documents/collections";
import {
  ROOT_COLLECTION_ID,
  documentsIndexAtom,
  openCollectionIdAtom,
} from "../documents/state";

import { DOCUMENTS_SIDEBAR_NAME } from "./AppDocumentsSidebar";
import { DocumentCard } from "./DocumentCard";

import "./CollectionDashboard.scss";

import type { DocumentId } from "../documents/storage";

export const CollectionDashboard = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const [openCollectionId, setOpenCollectionId] = useAtom(openCollectionIdAtom);
  const documentsIndex = useAtomValue(documentsIndexAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  // the sidebar stacks above the overlay — inset the overlay so its content
  // isn't hidden underneath
  const isDocumentsSidebarOpen =
    useUIAppState().openSidebar?.name === DOCUMENTS_SIDEBAR_NAME;

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isPendingDelete, setIsPendingDelete] = useState(false);

  const [renamingDocId, setRenamingDocId] = useState<DocumentId | null>(null);
  const [pendingDeleteDocId, setPendingDeleteDocId] =
    useState<DocumentId | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const isOpen = openCollectionId !== null;
  const collections = getCollections(documentsIndex);
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
    setRenamingDocId(null);
    setPendingDeleteDocId(null);
  }, [openCollectionId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // persist the active document's pending debounced save so its card
    // snapshot is up to date
    LocalData.flushSave();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // capture on window runs before the editor's document-level handler,
        // so the canvas doesn't also react
        event.stopPropagation();
        if (isRenaming) {
          // it also runs before the rename input's own handler — cancel the
          // rename instead of closing the dashboard
          setIsRenaming(false);
        } else if (renamingDocId) {
          setRenamingDocId(null);
        } else if (isPendingDelete) {
          setIsPendingDelete(false);
        } else if (pendingDeleteDocId) {
          setPendingDeleteDocId(null);
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
    renamingDocId,
    pendingDeleteDocId,
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

  const pendingDeleteDoc = documentsIndex.documents.find(
    (doc) => doc.id === pendingDeleteDocId,
  );

  const documents = documentsIndex.documents
    .filter(
      (doc) =>
        getDocumentCollectionId(doc, collections) ===
        (openCollectionId === ROOT_COLLECTION_ID ? null : openCollectionId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div
      className={clsx("collection-dashboard", {
        "collection-dashboard--sidebar-open": isDocumentsSidebarOpen,
      })}
      // keep the (undocked) documents sidebar open while interacting with
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
          Switching documents is disabled during a live collaboration session.
        </div>
      )}
      <div className="collection-dashboard__grid">
        {documents.map((doc) => (
          <DocumentCard
            key={doc.id}
            meta={doc}
            isActive={doc.id === documentsIndex.activeDocumentId}
            disabled={isCollaborating}
            isRenaming={doc.id === renamingDocId}
            onOpen={() => {
              switchToDocument(doc.id, excalidrawAPI);
              setOpenCollectionId(null);
            }}
            onRenameStart={() => setRenamingDocId(doc.id)}
            onRenameCommit={(name) => {
              renameDocument(doc.id, name, excalidrawAPI);
              setRenamingDocId(null);
            }}
            onDuplicate={() => duplicateDocument(doc.id)}
            onDeleteRequest={() => setPendingDeleteDocId(doc.id)}
          />
        ))}
        {!documents.length && (
          <div className="collection-dashboard__empty">
            No documents in this collection.
          </div>
        )}
      </div>
      {pendingDeleteDoc && (
        <ConfirmDialog
          title="Delete document"
          onConfirm={() => {
            deleteDocument(pendingDeleteDoc.id, excalidrawAPI);
            setPendingDeleteDocId(null);
          }}
          onCancel={() => setPendingDeleteDocId(null)}
        >
          <p>
            Are you sure you want to delete <b>{pendingDeleteDoc.name}</b>? This
            cannot be undone.
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
            Are you sure you want to delete <b>{collection.name}</b>? Its
            documents will move back to Dashboard.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
};
