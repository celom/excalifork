import { MIME_TYPES } from "@excalidraw/common";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { render, waitFor } from "@excalidraw/excalidraw/tests/test-utils";

import { appJotaiStore } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import { importSceneFromData } from "../scenes/actions";
import { createCollection } from "../scenes/collections";
import { getScenesIndex, openCollectionIdAtom } from "../scenes/state";
import { loadSceneSync } from "../scenes/storage";

import ExcalidrawApp from "../App";

const { h } = window;

const sceneFile = (elementId: string, filename: string) =>
  new File(
    [
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "test",
        elements: [
          API.createElement({
            type: "rectangle",
            id: elementId,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          }),
        ],
        appState: {},
      }),
    ],
    filename,
    { type: MIME_TYPES.json },
  );

describe("opening an individual .excalidraw file", () => {
  it("drag & drop appends it as a new scene instead of replacing the active one", async () => {
    await render(<ExcalidrawApp />);

    const before = getScenesIndex();
    const originalId = before.activeSceneId;

    await API.drop([
      { kind: "file", file: sceneFile("elem-dropped", "notes.excalidraw") },
    ]);

    await waitFor(() => {
      expect(getScenesIndex().activeSceneId).not.toBe(originalId);
    });

    const after = getScenesIndex();
    expect(after.scenes).toHaveLength(before.scenes.length + 1);

    // the new scene sits in the root collection, named after the file
    const imported = after.scenes.find(
      (scene) => scene.id === after.activeSceneId,
    )!;
    expect(imported.name).toBe("notes");
    expect(imported.collectionId ?? null).toBe(null);
    expect(loadSceneSync(imported.id)?.elements[0].id).toBe("elem-dropped");

    // the editor switched to the imported scene
    await waitFor(() => {
      expect(h.elements[0]?.id).toBe("elem-dropped");
    });

    // the previously active scene survives with its own (empty) content —
    // the dropped file did not replace it (the import flushes the outgoing
    // scene, so its blob is persisted, not overwritten)
    expect(after.scenes.some((scene) => scene.id === originalId)).toBe(true);
    expect(loadSceneSync(originalId)?.elements).toEqual([]);
  });

  it("drag & drop over an open collection page files the scene into that collection", async () => {
    await render(<ExcalidrawApp />);

    const collection = createCollection();
    appJotaiStore.set(openCollectionIdAtom, collection.id);
    try {
      const before = getScenesIndex();

      await API.drop([
        {
          kind: "file",
          file: sceneFile("elem-collected", "diagram.excalidraw"),
        },
      ]);

      await waitFor(() => {
        expect(getScenesIndex().activeSceneId).not.toBe(before.activeSceneId);
      });

      const after = getScenesIndex();
      const imported = after.scenes.find(
        (scene) => scene.id === after.activeSceneId,
      )!;
      expect(imported.name).toBe("diagram");
      expect(imported.collectionId).toBe(collection.id);
    } finally {
      appJotaiStore.set(openCollectionIdAtom, null);
    }
  });

  it("importSceneFromData bails out while collaborating so the editor default applies", async () => {
    await render(<ExcalidrawApp />);

    appJotaiStore.set(isCollaboratingAtom, true);
    try {
      const before = getScenesIndex();
      const result = await importSceneFromData(
        { elements: [], appState: {}, files: {} } as any,
        "collab file",
        null as any,
      );
      expect(result).toBe(null);
      expect(getScenesIndex()).toEqual(before);
    } finally {
      appJotaiStore.set(isCollaboratingAtom, false);
    }
  });
});
