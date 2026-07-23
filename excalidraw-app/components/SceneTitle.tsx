import { useAtomValue } from "../app-jotai";
import { scenesIndexAtom } from "../scenes/state";

import "./SceneTitle.scss";

export const SceneTitle = () => {
  const scenesIndex = useAtomValue(scenesIndexAtom);
  const activeScene = scenesIndex.scenes.find(
    (scene) => scene.id === scenesIndex.activeSceneId,
  );

  if (!activeScene?.name) {
    return null;
  }

  return (
    <div className="scene-title" title={activeScene.name}>
      {activeScene.name}
    </div>
  );
};
