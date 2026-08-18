import { reorderCollection, setCollectionIcon } from "../scenes/collections";
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
    expect(getScenesIndex().collections).toMatchObject([
      { id: "c1", name: "Ideas", createdAt: 1, icon: "brain" },
    ]);
  });

  it("stamps updatedAt, which cloud sync merges collections on", () => {
    // without it the change is invisible to `mergeCloudIndex`, and an older
    // copy of the collection on another device would keep winning
    setCollectionIcon("c1", "brain");
    expect(getScenesIndex().collections?.[0].updatedAt).toBeGreaterThan(1);
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

describe("reorderCollection", () => {
  const orderedIndex = (): ScenesIndex => ({
    version: 1,
    activeSceneId: "s1",
    scenes: [{ id: "s1", name: "Home", createdAt: 1, updatedAt: 1 }],
    collections: [
      { id: "a", name: "A", createdAt: 1 },
      { id: "b", name: "B", createdAt: 2 },
      { id: "c", name: "C", createdAt: 3 },
    ],
  });

  const order = () => getScenesIndex().collections?.map((c) => c.id);

  beforeEach(() => {
    setScenesIndex(orderedIndex());
  });

  it("moves a collection before the target", () => {
    reorderCollection("c", "a", "before");
    expect(order()).toEqual(["c", "a", "b"]);
  });

  it("moves a collection after the target", () => {
    reorderCollection("a", "c", "after");
    expect(order()).toEqual(["b", "c", "a"]);
  });

  it("resolves the target against the list the moved item was removed from", () => {
    // "before b" with a still in place would land at index 1, i.e. nowhere
    reorderCollection("a", "b", "before");
    expect(order()).toEqual(["a", "b", "c"]);
  });

  it("stamps orderedAt on the moved collection, and leaves updatedAt alone", () => {
    // `updatedAt` is what the rest of the collection merges on — a reorder
    // changed none of that, and bumping it would let a stale name win
    reorderCollection("c", "a", "before");
    const moved = getScenesIndex().collections?.find((c) => c.id === "c");
    expect(moved?.orderedAt).toBeGreaterThan(0);
    expect(moved?.updatedAt).toBeUndefined();
  });

  it("ignores a drop onto itself", () => {
    const before = getScenesIndex();
    reorderCollection("b", "b", "before");
    expect(getScenesIndex()).toEqual(before);
  });

  it("ignores unknown ids", () => {
    const before = getScenesIndex();
    reorderCollection("nope", "a", "before");
    reorderCollection("a", "nope", "before");
    expect(getScenesIndex()).toEqual(before);
  });
});
