import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  LoadIcon,
  downloadIcon,
} from "@excalidraw/excalidraw/components/icons";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { exportScenesArchive } from "../scenes/export";

import { startArchiveImport } from "./ArchiveImportFlow";

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  theme: Theme | "system";
  refresh: () => void;
}> = React.memo((props) => {
  const excalidrawAPI = useExcalidrawAPI();
  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.Item
        icon={LoadIcon}
        title="Import a previously exported collection (.zip of .excalidraw files)"
        // the active scene's local snapshot is stale during collab — same
        // gating as the dashboard's scene-data actions
        disabled={props.isCollaborating || !excalidrawAPI}
        onSelect={() => {
          if (excalidrawAPI) {
            startArchiveImport(excalidrawAPI);
          }
        }}
      >
        Import collection
      </MainMenu.Item>
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.Item
        icon={downloadIcon}
        title="Export all scenes and collections as a zip of .excalidraw files"
        disabled={props.isCollaborating}
        onSelect={() => exportScenesArchive("all")}
      >
        Export collection
      </MainMenu.Item>
      <MainMenu.DefaultItems.SaveAsImage />
      {props.isCollabEnabled && (
        <MainMenu.DefaultItems.LiveCollaborationTrigger
          isCollaborating={props.isCollaborating}
          onSelect={() => props.onCollabDialogOpen()}
        />
      )}
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
});
