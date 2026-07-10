import { Card } from "@excalidraw/excalidraw/components/Card";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import { ToolButton } from "@excalidraw/excalidraw/components/ToolButton";
import { useState } from "react";

import { appJotaiStore, useAtomValue } from "../app-jotai";
import {
  disableFolderSync,
  enableFolderSync,
  folderSyncErrorAtom,
  folderSyncFolderNameAtom,
  folderSyncStatusAtom,
  isFolderSyncSupported,
  reenableFolderSync,
} from "../scenes/folderSync";

import "./FolderSyncControl.scss";

// tabler-icons: folder-share (no fitting icon in the editor package)
const folderSyncIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13 19h-8a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v4" />
    <path d="M16 22l5 -5" />
    <path d="M21 21.5v-4.5h-4.5" />
  </svg>
);

/**
 * Sidebar control for the one-way folder mirror (see scenes/folderSync.ts).
 * Renders nothing on browsers without the File System Access API.
 */
export const FolderSyncControl = () => {
  const status = useAtomValue(folderSyncStatusAtom);
  const error = useAtomValue(folderSyncErrorAtom);
  const [isConfirmingStop, setIsConfirmingStop] = useState(false);

  if (!isFolderSyncSupported() || status === "unsupported") {
    return null;
  }

  return (
    <div className="folder-sync">
      {status === "off" && (
        <button
          type="button"
          className="folder-sync__action"
          title="Continuously save all scenes as .excalidraw files into a folder you pick"
          onClick={() => enableFolderSync()}
        >
          {folderSyncIcon}
          <span>Sync to folder…</span>
        </button>
      )}
      {status === "active" && (
        <div className="folder-sync__row">
          <span className="folder-sync__dot folder-sync__dot--active" />
          <span className="folder-sync__label">Syncing to folder</span>
          <button
            type="button"
            className="folder-sync__stop"
            onClick={() => setIsConfirmingStop(true)}
          >
            Stop
          </button>
        </div>
      )}
      {status === "needs-permission" && (
        <button
          type="button"
          className="folder-sync__action"
          title="The browser needs you to re-confirm access to the sync folder"
          onClick={() => reenableFolderSync()}
        >
          <span className="folder-sync__dot folder-sync__dot--warning" />
          <span>Resume folder sync</span>
        </button>
      )}
      {status === "error" && (
        <div className="folder-sync__row folder-sync__row--error">
          <span className="folder-sync__dot folder-sync__dot--error" />
          <span className="folder-sync__label" title={error ?? undefined}>
            {error ?? "Folder sync failed."}
          </span>
          <button
            type="button"
            className="folder-sync__stop"
            onClick={() => enableFolderSync()}
          >
            Choose folder…
          </button>
        </div>
      )}
      {isConfirmingStop && (
        <ConfirmDialog
          title="Stop folder sync"
          onConfirm={() => {
            disableFolderSync();
            setIsConfirmingStop(false);
          }}
          onCancel={() => setIsConfirmingStop(false)}
        >
          <p>
            Scenes will no longer be saved to the folder. Files already written
            are kept on disk.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
};

/**
 * Entry-point card for the JSON export dialog. While sync is off it
 * offers to pick a folder; once enabled it reflects the sync status and
 * the folder name (the File System Access API never exposes full paths).
 */
export const FolderSyncExportCard = ({
  onEnabled,
}: {
  onEnabled: () => void;
}) => {
  const status = useAtomValue(folderSyncStatusAtom);
  const error = useAtomValue(folderSyncErrorAtom);
  const folderName = useAtomValue(folderSyncFolderNameAtom);

  if (!isFolderSyncSupported() || status === "unsupported") {
    return null;
  }

  const chooseFolder = async () => {
    try {
      await enableFolderSync();
    } catch (error: any) {
      console.error(error);
      return;
    }
    // enableFolderSync returns silently when the picker is
    // dismissed — only close the dialog if sync actually started
    if (appJotaiStore.get(folderSyncStatusAtom) === "active") {
      onEnabled();
    }
  };

  return (
    <Card color="lime">
      <div className="Card-icon">{folderSyncIcon}</div>
      <h2>Sync to folder</h2>
      <div className="Card-details">
        {status === "off" &&
          "Continuously save all your scenes as .excalidraw files into a folder you pick."}
        {status === "active" && (
          <>
            <span className="folder-sync-card__status">
              <span className="folder-sync__dot folder-sync__dot--active" />
              Syncing to folder
            </span>
            {folderName && (
              <span className="folder-sync-card__folder" title={folderName}>
                {folderName}
              </span>
            )}
          </>
        )}
        {status === "needs-permission" && (
          <>
            <span className="folder-sync-card__status">
              <span className="folder-sync__dot folder-sync__dot--warning" />
              Sync paused
            </span>
            The browser needs you to re-confirm access to
            {folderName ? ` “${folderName}”` : " the sync folder"}.
          </>
        )}
        {status === "error" && (
          <>
            <span className="folder-sync-card__status">
              <span className="folder-sync__dot folder-sync__dot--error" />
              Sync failed
            </span>
            {error ?? "Folder sync failed."}
          </>
        )}
      </div>
      {status === "active" ? (
        <ToolButton
          className="Card-button"
          type="button"
          title="Change folder"
          aria-label="Change folder"
          showAriaLabel={true}
          onClick={chooseFolder}
        />
      ) : status === "needs-permission" ? (
        <ToolButton
          className="Card-button"
          type="button"
          title="Resume sync"
          aria-label="Resume sync"
          showAriaLabel={true}
          onClick={() => reenableFolderSync()}
        />
      ) : (
        <ToolButton
          className="Card-button"
          type="button"
          title="Choose folder"
          aria-label="Choose folder"
          showAriaLabel={true}
          onClick={chooseFolder}
        />
      )}
    </Card>
  );
};
