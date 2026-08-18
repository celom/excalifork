/**
 * Sort keys for user-controlled order (scenes/ordering.ts), and `reorderScene`
 * on top of them.
 *
 * The keys are what makes a reorder survive cloud sync, so most cases below
 * are about a key staying strictly between its neighbours — one that ties or
 * overshoots puts the item somewhere the user didn't drop it.
 */

import { reorderScene } from "../scenes/actions";
import {
  ORDER_STEP,
  backfillOrder,
  compareOrder,
  orderKey,
  reorderKeys,
  sortByOrder,
} from "../scenes/ordering";

import { getScenesIndex, setScenesIndex } from "../scenes/state";

import type { Ordered } from "../scenes/ordering";
import type { ScenesIndex } from "../scenes/storage";

const item = (id: string, extra: Partial<Ordered> = {}): Ordered => ({
  id,
  createdAt: 1,
  ...extra,
});

/** applies the returned keys and reads back the resulting sequence */
const applied = (
  items: Ordered[],
  id: string,
  targetId: string,
  position: "before" | "after",
) => {
  const keys = reorderKeys(items, id, targetId, position);
  if (!keys) {
    return null;
  }
  return sortByOrder(
    items.map((entry) => {
      const order = keys.get(entry.id);
      return order === undefined ? entry : { ...entry, order };
    }),
  ).map((entry) => entry.id);
};

describe("orderKey", () => {
  it("falls back to createdAt, so an item written before sort keys existed still sorts", () => {
    expect(orderKey(item("a", { createdAt: 42 }))).toBe(42);
    expect(orderKey(item("a", { createdAt: 42, order: 7 }))).toBe(7);
  });

  it("sorts a new item last — its createdAt is far above any backfilled key", () => {
    const backfilled = item("old", { order: 3 * ORDER_STEP });
    const fresh = item("new", { createdAt: Date.now() });
    expect(sortByOrder([fresh, backfilled]).map((i) => i.id)).toEqual([
      "old",
      "new",
    ]);
  });
});

describe("compareOrder", () => {
  it("breaks ties by id, so every device agrees", () => {
    // an archive import stamps one createdAt across the whole batch
    const a = item("a", { createdAt: 5 });
    const b = item("b", { createdAt: 5 });
    expect(compareOrder(a, b)).toBeLessThan(0);
    expect(compareOrder(b, a)).toBeGreaterThan(0);
  });
});

describe("backfillOrder", () => {
  it("pins the current array order onto the items", () => {
    const result = backfillOrder([item("a"), item("b"), item("c")]);
    expect(result?.map((i) => [i.id, i.order])).toEqual([
      ["a", 0],
      ["b", ORDER_STEP],
      ["c", 2 * ORDER_STEP],
    ]);
  });

  it("preserves an order the array order alone would lose", () => {
    // all three share a createdAt — without the backfill, sorting would
    // reshuffle them by id and the user's arrangement would be gone
    const items = [item("c"), item("a"), item("b")];
    expect(sortByOrder(backfillOrder(items)!).map((i) => i.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("returns null once every item has a key, so the caller skips the write", () => {
    expect(
      backfillOrder([item("a", { order: 1 }), item("b", { order: 2 })]),
    ).toBeNull();
  });
});

describe("reorderKeys", () => {
  const list = [
    item("a", { order: 100 }),
    item("b", { order: 200 }),
    item("c", { order: 300 }),
  ];

  it("moves an item before the target", () => {
    expect(applied(list, "c", "a", "before")).toEqual(["c", "a", "b"]);
  });

  it("moves an item after the target", () => {
    expect(applied(list, "a", "c", "after")).toEqual(["b", "c", "a"]);
  });

  it("moves an item into the middle", () => {
    expect(applied(list, "a", "b", "after")).toEqual(["b", "a", "c"]);
  });

  it("stamps only the moved item, so a concurrent edit elsewhere survives the merge", () => {
    const keys = reorderKeys(list, "c", "a", "before");
    expect([...keys!.keys()]).toEqual(["c"]);
  });

  it("resolves the target against the list the moved item was removed from", () => {
    // "before b" with a still in place would mean "stay put"
    expect(applied(list, "a", "b", "before")).toEqual(["a", "b", "c"]);
  });

  it("ignores a drop onto itself", () => {
    expect(reorderKeys(list, "b", "b", "before")).toBeNull();
  });

  it("ignores unknown ids", () => {
    expect(reorderKeys(list, "nope", "a", "before")).toBeNull();
    expect(reorderKeys(list, "a", "nope", "before")).toBeNull();
  });

  it("respaces the whole list when the neighbours leave no room", () => {
    // equal keys have no midpoint between them — a folder import gives every
    // collection the same createdAt, and nothing has been reordered since
    const tied = [item("a"), item("b"), item("c")];
    const keys = reorderKeys(tied, "a", "c", "before")!;
    expect(keys.size).toBe(3);
    expect(applied(tied, "a", "c", "before")).toEqual(["b", "a", "c"]);
  });

  it("still stamps one key when a tied list is dropped past its end", () => {
    // there is always room outside the list, however tightly packed it is
    const tied = [item("a"), item("b"), item("c")];
    expect(reorderKeys(tied, "c", "a", "before")!.size).toBe(1);
    expect(applied(tied, "c", "a", "before")).toEqual(["c", "a", "b"]);
  });

  it("respaces rather than collide once floats run out of precision", () => {
    const adjacent = [
      item("a", { order: 1 }),
      item("b", { order: 1 + Number.EPSILON }),
      item("c", { order: 9 }),
    ];
    const keys = reorderKeys(adjacent, "c", "b", "before")!;
    expect(keys.size).toBe(3);
    expect(applied(adjacent, "c", "b", "before")).toEqual(["a", "c", "b"]);
  });

  it("keeps a repeated move to the front strictly ahead of the rest", () => {
    let items = [item("a", { order: 0 }), item("b", { order: ORDER_STEP })];
    for (let round = 0; round < 50; round++) {
      const front = round % 2 === 0 ? "b" : "a";
      const target = round % 2 === 0 ? "a" : "b";
      const keys = reorderKeys(items, front, target, "before")!;
      items = items.map((entry) => {
        const order = keys.get(entry.id);
        return order === undefined ? entry : { ...entry, order };
      });
      expect(sortByOrder(items).map((i) => i.id)[0]).toBe(front);
    }
  });
});

describe("reorderScene", () => {
  const fixture = (): ScenesIndex => ({
    version: 1,
    activeSceneId: "a",
    scenes: [
      { id: "a", name: "A", createdAt: 1, updatedAt: 100, order: 0 },
      // sits between them in the index, but in another collection — the
      // dashboard never shows it next to these two
      { id: "x", name: "X", createdAt: 2, updatedAt: 100, order: 1000 },
      { id: "b", name: "B", createdAt: 3, updatedAt: 100, order: 2000 },
    ],
  });

  const order = () => getScenesIndex().scenes.map((scene) => scene.id);

  beforeEach(() => {
    setScenesIndex(fixture());
  });

  it("moves a scene before the target", () => {
    reorderScene("b", "a", "before");
    expect(order()).toEqual(["b", "a", "x"]);
  });

  it("moves a scene after the target", () => {
    reorderScene("a", "b", "after");
    expect(order()).toEqual(["x", "b", "a"]);
  });

  it("lands next to the target even with a foreign scene between them", () => {
    // the dashboard shows a filtered view, so "after a" means "immediately
    // after a" there — the scene in another collection must not intervene
    reorderScene("b", "a", "after");
    expect(order()).toEqual(["a", "b", "x"]);
  });

  it("leaves updatedAt alone — it is a content clock, not a position one", () => {
    // bumping it would let a reorder beat a real edit made on another device
    reorderScene("b", "a", "before");
    expect(
      getScenesIndex().scenes.every((scene) => scene.updatedAt === 100),
    ).toBe(true);
  });

  it("stamps orderedAt on the moved scene only", () => {
    reorderScene("b", "a", "before");
    const stamped = getScenesIndex().scenes.filter(
      (scene) => scene.orderedAt !== undefined,
    );
    expect(stamped.map((scene) => scene.id)).toEqual(["b"]);
  });

  it("ignores a drop onto itself and unknown ids", () => {
    const before = getScenesIndex();
    reorderScene("a", "a", "before");
    reorderScene("nope", "a", "before");
    reorderScene("a", "nope", "before");
    expect(getScenesIndex()).toEqual(before);
  });
});
