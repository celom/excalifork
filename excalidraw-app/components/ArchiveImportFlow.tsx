import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom, useAtom } from "../app-jotai";
import { detectConflicts } from "../scenes/archive";
import { pickZipFile } from "../scenes/fileio";
import { applyArchiveImport, readArchive } from "../scenes/import";
import { getScenesIndex } from "../scenes/state";

import { ArchiveConflictDialog } from "./ArchiveConflictDialog";

import type { ParsedArchive } from "../scenes/import";

type PendingArchiveImport = {
  archive: ParsedArchive;
  conflictingSceneCount: number;
  conflictingCollectionCount: number;
};

export const pendingArchiveImportAtom = atom<PendingArchiveImport | null>(null);
export const archiveImportErrorAtom = atom<string | null>(null);

/**
 * Pick an archive zip and import it, prompting on id conflicts. Shared by
 * the main menu and the dashboard — the dialogs live in
 * <ArchiveImportDialogs/>, which is mounted app-wide.
 */
export const startArchiveImport = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  const file = await pickZipFile();
  if (!file) {
    return;
  }
  try {
    const archive = await readArchive(file);
    const conflicts = detectConflicts(archive.manifest, getScenesIndex());
    if (
      conflicts.sceneConflicts.length ||
      conflicts.collectionConflicts.length
    ) {
      appJotaiStore.set(pendingArchiveImportAtom, {
        archive,
        conflictingSceneCount: conflicts.sceneConflicts.length,
        conflictingCollectionCount: conflicts.collectionConflicts.length,
      });
    } else {
      await applyArchiveImport({ archive, resolution: null, excalidrawAPI });
    }
  } catch (error: any) {
    console.error(error);
    appJotaiStore.set(archiveImportErrorAtom, error.message);
  }
};

export const ArchiveImportDialogs = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const [pendingImport, setPendingImport] = useAtom(pendingArchiveImportAtom);
  const [importError, setImportError] = useAtom(archiveImportErrorAtom);

  if (!excalidrawAPI) {
    return null;
  }

  return (
    <>
      {pendingImport && (
        <ArchiveConflictDialog
          sceneCount={pendingImport.archive.manifest.scenes.length}
          collectionCount={pendingImport.archive.manifest.collections.length}
          conflictingSceneCount={pendingImport.conflictingSceneCount}
          conflictingCollectionCount={pendingImport.conflictingCollectionCount}
          onCancel={() => setPendingImport(null)}
          onResolve={async (resolution) => {
            setPendingImport(null);
            try {
              await applyArchiveImport({
                archive: pendingImport.archive,
                resolution,
                excalidrawAPI,
              });
            } catch (error: any) {
              console.error(error);
              setImportError(error.message);
            }
          }}
        />
      )}
      {importError && (
        <ErrorDialog onClose={() => setImportError(null)}>
          {importError}
        </ErrorDialog>
      )}
    </>
  );
};
