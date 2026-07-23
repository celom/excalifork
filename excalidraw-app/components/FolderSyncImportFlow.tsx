import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import DialogActionButton from "@excalidraw/excalidraw/components/DialogActionButton";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { useState } from "react";
import { flushSync } from "react-dom";

import { useAtom } from "../app-jotai";
import { getCollections } from "../scenes/collections";
import { mergeCollectionsByName } from "../scenes/folderImport";
import {
  activateFolderSync,
  folderSyncImportErrorAtom,
  pendingFolderSyncImportAtom,
} from "../scenes/folderSync";
import { applyArchiveImport } from "../scenes/import";
import { getScenesIndex } from "../scenes/state";

import "./FolderSyncImportFlow.scss";

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Dialogs finishing a parked folder-sync activation (see
 * `pendingFolderSyncImportAtom` in scenes/folderSync.ts): the picked
 * folder already contains `.excalidraw` files, so the user chooses to
 * append them to the workspace or to replace the workspace with them
 * (behind a second, destructive-action confirmation). Mounted app-wide,
 * like <ArchiveImportDialogs/>.
 */
export const FolderSyncImportDialogs = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const [pending, setPending] = useAtom(pendingFolderSyncImportAtom);
  const [error, setError] = useAtom(folderSyncImportErrorAtom);
  const [isConfirmingReplace, setIsConfirmingReplace] = useState(false);

  if (!excalidrawAPI) {
    return null;
  }

  const cancel = () => {
    setPending(null);
    setIsConfirmingReplace(false);
  };

  const finish = async (mode: "merge" | "replace") => {
    if (!pending) {
      return;
    }
    const { handle, archive } = pending;
    setPending(null);
    setIsConfirmingReplace(false);
    try {
      const manifest =
        mode === "merge"
          ? mergeCollectionsByName(
              archive.manifest,
              getCollections(getScenesIndex()),
            )
          : archive.manifest;
      const { importedScenes } = await applyArchiveImport({
        archive: { ...archive, manifest },
        resolution: null,
        excalidrawAPI,
        mode,
      });
      if (importedScenes === 0) {
        // every entry was unreadable (or a collab session blocks imports) —
        // never activate over a folder we failed to bring in: in replace
        // mode the mirror would clobber it
        setError(
          "None of the folder's files could be imported — folder sync was not enabled.",
        );
        return;
      }
      await activateFolderSync(handle);
    } catch (error: any) {
      console.error(error);
      setError(error.message);
    }
  };

  const manifest = pending?.archive.manifest;

  return (
    <>
      {pending && manifest && !isConfirmingReplace && (
        <Dialog
          title="Folder already contains drawings"
          size="small"
          onCloseRequest={cancel}
          className="folder-sync-import-dialog"
        >
          <p>
            “{pending.handle.name}” contains{" "}
            {plural(manifest.scenes.length, "drawing")}
            {manifest.collections.length
              ? ` in ${plural(manifest.collections.length, "folder")}`
              : ""}
            .
          </p>
          <p>
            <b>Append</b> adds them to your workspace as new scenes.{" "}
            <b>Replace workspace</b> deletes your current scenes and imports the
            folder's files instead.
          </p>
          <div className="folder-sync-import-dialog__buttons">
            <DialogActionButton label="Cancel" onClick={cancel} />
            <DialogActionButton
              label="Append"
              onClick={() =>
                // flush before the caller re-focuses the container (see
                // ConfirmDialog for the chromium crash this avoids)
                flushSync(() => {
                  finish("merge");
                })
              }
            />
            <DialogActionButton
              label="Replace workspace…"
              actionType="danger"
              onClick={() => setIsConfirmingReplace(true)}
            />
          </div>
        </Dialog>
      )}
      {pending && isConfirmingReplace && (
        <ConfirmDialog
          title="Delete current workspace?"
          confirmText="Delete and replace"
          onConfirm={() => finish("replace")}
          onCancel={cancel}
        >
          <p>
            Your current workspace —{" "}
            {plural(getScenesIndex().scenes.length, "scene")} — will be
            permanently deleted and replaced with the folder's drawings. This
            cannot be undone.
          </p>
        </ConfirmDialog>
      )}
      {error && (
        <ErrorDialog onClose={() => setError(null)}>{error}</ErrorDialog>
      )}
    </>
  );
};
