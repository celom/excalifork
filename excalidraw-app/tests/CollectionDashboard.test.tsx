import { KEYS } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Keyboard } from "@excalidraw/excalidraw/tests/helpers/ui";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";

import { SCENE_DRAG_MIME } from "../scenes/collections";
import {
  ROOT_COLLECTION_ID,
  openCollectionIdAtom,
  scenesSidebarPinnedAtom,
} from "../scenes/state";
import { appJotaiStore } from "../app-jotai";
import { SCENES_SIDEBAR_NAME } from "../components/AppScenesSidebar";

import ExcalidrawApp from "../App";

const { h } = window;

const openDashboard = async () => {
  act(() => {
    appJotaiStore.set(openCollectionIdAtom, ROOT_COLLECTION_ID);
  });
  await waitFor(() => {
    expect(document.querySelector(".collection-dashboard")).not.toBeNull();
  });
};

const closeDashboard = async () => {
  act(() => {
    appJotaiStore.set(openCollectionIdAtom, null);
  });
  await waitFor(() => {
    expect(document.querySelector(".collection-dashboard")).toBeNull();
  });
};

/** puts the scene in the state the leak needs: one element, selected
 * (a freshly drawn shape stays selected) */
const createSelectedRect = () => {
  const rect = API.createElement({
    type: "rectangle",
    id: "A",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  API.updateScene({
    elements: [rect],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.setSelectedElements([rect]);
};

describe("CollectionDashboard", () => {
  it("swallows editor shortcuts while open, and stops swallowing on close", async () => {
    await render(<ExcalidrawApp />);
    createSelectedRect();

    await openDashboard();

    // the editor stays mounted (listening on document) beneath the
    // overlay — Delete must not reach it and delete the selection
    Keyboard.keyPress(KEYS.DELETE);
    expect(h.elements[0].isDeleted).toBe(false);

    await closeDashboard();

    // control: with the dashboard closed the same keypress reaches the
    // editor — proves the assertion above exercises the real key path
    Keyboard.keyPress(KEYS.DELETE);
    expect(h.elements[0].isDeleted).toBe(true);
  });

  it("swallows clipboard cut while open (cut deletes the selection)", async () => {
    await render(<ExcalidrawApp />);
    createSelectedRect();

    // clipboard events aren't preceded by a swallowed keydown when
    // triggered via the browser's Edit menu — dispatch them directly
    const cut = () => {
      document.dispatchEvent(
        new ClipboardEvent("cut", { clipboardData: new DataTransfer() }),
      );
    };

    await openDashboard();

    cut();
    expect(h.elements[0].isDeleted).toBe(false);

    await closeDashboard();

    // control: proves the cut event reaches the editor once closed
    cut();
    await waitFor(() => {
      expect(h.elements[0].isDeleted).toBe(true);
    });
  });

  it("closes when the scenes sidebar closes", async () => {
    await render(<ExcalidrawApp />);

    act(() => {
      h.app.toggleSidebar({ name: SCENES_SIDEBAR_NAME, force: true });
    });
    await openDashboard();

    act(() => {
      h.app.toggleSidebar({ name: SCENES_SIDEBAR_NAME, force: false });
    });
    await waitFor(() => {
      expect(document.querySelector(".collection-dashboard")).toBeNull();
    });
  });

  it("opening a scene closes the sidebar when unpinned", async () => {
    await render(<ExcalidrawApp />);

    act(() => {
      h.app.toggleSidebar({ name: SCENES_SIDEBAR_NAME, force: true });
    });
    await openDashboard();

    fireEvent.click(document.querySelector(".scene-card")!);

    await waitFor(() => {
      expect(document.querySelector(".collection-dashboard")).toBeNull();
      expect(h.state.openSidebar).toBeNull();
    });
  });

  it("opening a scene keeps the sidebar open when pinned", async () => {
    await render(<ExcalidrawApp />);

    act(() => {
      appJotaiStore.set(scenesSidebarPinnedAtom, true);
      h.app.toggleSidebar({ name: SCENES_SIDEBAR_NAME, force: true });
    });
    try {
      await openDashboard();

      fireEvent.click(document.querySelector(".scene-card")!);

      await waitFor(() => {
        expect(document.querySelector(".collection-dashboard")).toBeNull();
      });
      expect(h.state.openSidebar).toEqual({ name: SCENES_SIDEBAR_NAME });
    } finally {
      act(() => {
        appJotaiStore.set(scenesSidebarPinnedAtom, false);
      });
    }
  });

  it("hides the folder-sync control without File System Access support", async () => {
    await render(<ExcalidrawApp />);

    act(() => {
      h.app.toggleSidebar({ name: SCENES_SIDEBAR_NAME, force: true });
    });
    await waitFor(() => {
      expect(document.querySelector(".scenes-tab")).not.toBeNull();
    });
    // jsdom has no showDirectoryPicker — the control must not render
    expect("showDirectoryPicker" in window).toBe(false);
    expect(document.querySelector(".folder-sync")).toBeNull();
  });

  it("highlights the page while a file is dragged over it", async () => {
    await render(<ExcalidrawApp />);

    await openDashboard();
    const dashboard = document.querySelector(".collection-dashboard")!;

    fireEvent.dragOver(dashboard, { dataTransfer: { types: ["Files"] } });
    expect(
      dashboard.classList.contains("collection-dashboard--file-drag"),
    ).toBe(true);
    expect(
      document.querySelector(".collection-dashboard__drop-hint"),
    ).not.toBeNull();

    // leaving the page (relatedTarget outside it) removes the highlight
    fireEvent.dragLeave(dashboard, { relatedTarget: document.body });
    expect(
      dashboard.classList.contains("collection-dashboard--file-drag"),
    ).toBe(false);
    expect(
      document.querySelector(".collection-dashboard__drop-hint"),
    ).toBeNull();
  });

  it("does not highlight for internal scene-card drags", async () => {
    await render(<ExcalidrawApp />);

    await openDashboard();
    const dashboard = document.querySelector(".collection-dashboard")!;

    fireEvent.dragOver(dashboard, {
      dataTransfer: { types: [SCENE_DRAG_MIME] },
    });
    expect(
      dashboard.classList.contains("collection-dashboard--file-drag"),
    ).toBe(false);
  });

  it("still closes on Escape", async () => {
    await render(<ExcalidrawApp />);

    await openDashboard();

    Keyboard.keyPress(KEYS.ESCAPE);
    await waitFor(() => {
      expect(document.querySelector(".collection-dashboard")).toBeNull();
    });
  });
});
