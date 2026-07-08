import { THEME } from "@excalidraw/common";
import { exportToCanvas } from "@excalidraw/excalidraw";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import {
  getCommonBounds,
  isInitializedImageElement,
  newFrameElement,
} from "@excalidraw/element";
import { useEffect, useRef, useState } from "react";

import type { FileId } from "@excalidraw/element/types";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { LocalData } from "../data/LocalData";
import { loadSceneSync } from "../scenes/storage";

import type { SceneMeta } from "../scenes/storage";

// fallback when the preview box can't be measured
const FALLBACK_PREVIEW_SIZE = 240;
const PREVIEW_PADDING = 8;

export type ScenePreviewStatus = "loading" | "ready" | "empty" | "error";

/**
 * Renders a scene snapshot into the returned host div (imperatively, via
 * replaceChildren). The host must stay mounted across status changes, never
 * receive React children, and sit inside an always-visible parent whose box
 * decides the snapshot's aspect ratio and resolution.
 */
export const useScenePreview = (meta: SceneMeta) => {
  const { theme } = useUIAppState();
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ScenePreviewStatus>("loading");

  useEffect(() => {
    // guards against a stale export resolving after a newer one (or unmount)
    let cancelled = false;
    const isStale = () => cancelled;

    const renderPreview = async () => {
      const data = loadSceneSync(meta.id);
      const elements = data?.elements.filter((element) => !element.isDeleted);
      if (!elements?.length) {
        setStatus("empty");
        return;
      }

      const fileIds = elements.reduce((acc, element) => {
        if (isInitializedImageElement(element)) {
          acc.push(element.fileId);
        }
        return acc;
      }, [] as FileId[]);

      const files: BinaryFiles = {};
      if (fileIds.length) {
        const { loadedFiles } = await LocalData.fileStorage.getFiles(fileIds);
        if (isStale()) {
          return;
        }
        for (const file of loadedFiles) {
          files[file.id] = file;
        }
      }

      // snapshot a region matching the preview box's aspect ratio (a frame
      // export crops to the exact frame rect), so the canvas background
      // fills the box with no letterboxing
      // (the host itself may be display: none while loading — measure its
      // always-visible parent)
      const box = canvasHostRef.current?.parentElement?.getBoundingClientRect();
      const boxRatio = box?.width && box?.height ? box.width / box.height : 1;
      const [minX, minY, maxX, maxY] = getCommonBounds(elements);
      let width = maxX - minX + PREVIEW_PADDING * 2;
      let height = maxY - minY + PREVIEW_PADDING * 2;
      if (width / height < boxRatio) {
        width = height * boxRatio;
      } else {
        height = width / boxRatio;
      }

      // render at the box's real device-pixel size so the snapshot stays
      // crisp on retina displays and in wide boxes (maxWidthOrHeight
      // won't do — it only downscales, and the frame is in scene units)
      const targetWidth = Math.ceil(
        (box?.width ?? FALLBACK_PREVIEW_SIZE) * window.devicePixelRatio,
      );

      const canvas = await exportToCanvas({
        elements,
        appState: {
          ...data?.appState,
          exportBackground: true,
          exportWithDarkMode: theme === THEME.DARK,
        },
        files,
        exportingFrame: newFrameElement({
          x: (minX + maxX) / 2 - width / 2,
          y: (minY + maxY) / 2 - height / 2,
          width,
          height,
        }),
        getDimensions: (frameWidth, frameHeight) => {
          const scale = targetWidth / frameWidth;
          return {
            width: targetWidth,
            height: Math.ceil(frameHeight * scale),
            scale,
          };
        },
      });
      if (isStale()) {
        return;
      }
      canvasHostRef.current?.replaceChildren(canvas);
      setStatus("ready");
    };

    renderPreview().catch((error: any) => {
      console.error(error);
      if (!isStale()) {
        setStatus("error");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.updatedAt, theme]);

  return { canvasHostRef, status };
};
