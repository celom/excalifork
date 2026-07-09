import { Sidebar } from "@excalidraw/excalidraw";

import { useAtom } from "../app-jotai";
import { SCENES_SIDEBAR_NAME, scenesSidebarPinnedAtom } from "../scenes/state";

import { ScenesTab } from "./ScenesTab";

export { SCENES_SIDEBAR_NAME };

export const AppScenesSidebar = () => {
  const [isPinned, setIsPinned] = useAtom(scenesSidebarPinnedAtom);

  return (
    <Sidebar
      name={SCENES_SIDEBAR_NAME}
      position="left"
      docked={isPinned}
      onDock={setIsPinned}
    >
      <Sidebar.Header className="scenes-sidebar__header">
        <div className="scenes-tab__header-title">Scenes folder</div>
      </Sidebar.Header>
      <ScenesTab />
    </Sidebar>
  );
};
