import { setCollectionIcon } from "../scenes/collections";
import { getScenesIndex, setScenesIndex } from "../scenes/state";

import type { ScenesIndex } from "../scenes/storage";

const fixtureIndex = (): ScenesIndex => ({
  version: 1,
  activeSceneId: "s1",
  scenes: [{ id: "s1", name: "Home", createdAt: 1, updatedAt: 1 }],
  collections: [{ id: "c1", name: "Ideas", createdAt: 1 }],
});

describe("setCollectionIcon", () => {
  beforeEach(() => {
    setScenesIndex(fixtureIndex());
  });

  it("sets the icon on the target collection", () => {
    setCollectionIcon("c1", "brain");
    expect(getScenesIndex().collections).toEqual([
      { id: "c1", name: "Ideas", createdAt: 1, icon: "brain" },
    ]);
  });

  it("clears the icon with null", () => {
    setCollectionIcon("c1", "brain");
    setCollectionIcon("c1", null);
    expect(getScenesIndex().collections?.[0].icon).toBeUndefined();
  });

  it("ignores unknown collections", () => {
    const before = getScenesIndex();
    setCollectionIcon("nope", "brain");
    expect(getScenesIndex()).toEqual(before);
  });
});
