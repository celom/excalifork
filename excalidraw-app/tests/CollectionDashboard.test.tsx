import { KEYS } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Keyboard } from "@excalidraw/excalidraw/tests/helpers/ui";
import { act, render, waitFor } from "@excalidraw/excalidraw/tests/test-utils";

import { ROOT_COLLECTION_ID, openCollectionIdAtom } from "../scenes/state";
import { appJotaiStore } from "../app-jotai";

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

  it("still closes on Escape", async () => {
    await render(<ExcalidrawApp />);

    await openDashboard();

    Keyboard.keyPress(KEYS.ESCAPE);
    await waitFor(() => {
      expect(document.querySelector(".collection-dashboard")).toBeNull();
    });
  });
});
