/**
 * Sort keys for the user-controlled order of scenes and collections.
 *
 * Order has to survive cloud sync, and a position in an array cannot: the
 * merge works one item at a time, so an array index is not a property it can
 * compare. A numeric key per item is — a reorder stamps one on the item that
 * moved, `orderedAt` records when, and `cloudMerge` takes the newer of the
 * two sides.
 *
 * The keys are opaque; only their relative order means anything. An item
 * carrying none falls back to `createdAt`, which sorts it last (every key
 * `backfillOrder` writes is far below epoch-millis) — matching the "a new
 * scene appends" behaviour the dashboard already had, with no key to mint
 * at creation time.
 */

export type Ordered = {
  id: string;
  createdAt: number;
  /** sort key — absent until the item is reordered or backfilled */
  order?: number;
  /** when `order` was last set by a user reorder; the merge's clock for it */
  orderedAt?: number;
};

/** spacing for backfilled keys, and the step taken past either end */
export const ORDER_STEP = 1000;

export const orderKey = (item: Ordered) => item.order ?? item.createdAt;

/**
 * `id` breaks ties so that every device agrees on the result. Equal keys are
 * normal rather than exotic — an archive import stamps one `createdAt` across
 * the whole batch.
 */
export const compareOrder = (a: Ordered, b: Ordered) =>
  orderKey(a) - orderKey(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const sortByOrder = <T extends Ordered>(items: readonly T[]): T[] =>
  [...items].sort(compareOrder);

/**
 * Stamps a key on every item, preserving the array order they are in — which
 * is the order the user currently sees, and the thing that would otherwise be
 * lost the moment sorting starts. Returns `null` once every item has a key,
 * so the caller can skip the write.
 */
export const backfillOrder = <T extends Ordered>(
  items: readonly T[],
): T[] | null =>
  items.some((item) => item.order === undefined)
    ? items.map((item, index) => ({ ...item, order: index * ORDER_STEP }))
    : null;

/**
 * Sort keys for moving `id` next to `targetId`, or `null` if the move can't
 * be made (unknown id, or a drop onto itself).
 *
 * Normally one entry: a key midway between the moved item's new neighbours,
 * so that a concurrent edit to any other item survives the merge untouched.
 * When the neighbours leave no room between them — equal keys, or floats too
 * close to split — the whole list is respaced instead and every item comes
 * back.
 */
export const reorderKeys = <T extends Ordered>(
  items: readonly T[],
  id: string,
  targetId: string,
  position: "before" | "after",
): Map<string, number> | null => {
  if (id === targetId) {
    return null;
  }
  const sorted = sortByOrder(items);
  const moved = sorted.find((item) => item.id === id);
  const rest = sorted.filter((item) => item.id !== id);
  const targetIndex = rest.findIndex((item) => item.id === targetId);
  if (!moved || targetIndex === -1) {
    return null;
  }

  const insertAt = position === "before" ? targetIndex : targetIndex + 1;
  // `rest` holds the target, so at least one neighbour always exists
  const before = rest[insertAt - 1];
  const after = rest[insertAt];
  const key = !before
    ? orderKey(after) - ORDER_STEP
    : !after
    ? orderKey(before) + ORDER_STEP
    : (orderKey(before) + orderKey(after)) / 2;

  if (
    (!before || key > orderKey(before)) &&
    (!after || key < orderKey(after))
  ) {
    return new Map([[id, key]]);
  }

  rest.splice(insertAt, 0, moved);
  return new Map(rest.map((item, index) => [item.id, index * ORDER_STEP]));
};
