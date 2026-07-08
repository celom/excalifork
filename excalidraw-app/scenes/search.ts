/**
 * Scene search over titles and scene text content.
 *
 * Content search scans the text elements persisted for each scene. The
 * extracted texts are cached per scene keyed on `updatedAt`, so after the
 * first scan a keystroke only costs substring checks over cached strings.
 */

import { loadSceneSync } from "./storage";

import type { SceneId, SceneMeta, ScenesIndex } from "./storage";

export type SceneSearchMatch = {
  meta: SceneMeta;
  /** excerpt around the matched content — null when the title matched */
  snippet: string | null;
};

type TextCacheEntry = { updatedAt: number; texts: string[] };
const textCache = new Map<SceneId, TextCacheEntry>();

const getSceneTexts = (meta: SceneMeta): string[] => {
  const cached = textCache.get(meta.id);
  if (cached && cached.updatedAt === meta.updatedAt) {
    return cached.texts;
  }
  const texts: string[] = [];
  for (const element of loadSceneSync(meta.id)?.elements ?? []) {
    if (element.type === "text" && !element.isDeleted && element.text.trim()) {
      texts.push(element.text);
    }
  }
  textCache.set(meta.id, { updatedAt: meta.updatedAt, texts });
  return texts;
};

const SNIPPET_CONTEXT_CHARS = 24;

const makeSnippet = (text: string, query: string): string | null => {
  const matchIndex = text.toLowerCase().indexOf(query);
  if (matchIndex === -1) {
    return null;
  }
  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(
    text.length,
    matchIndex + query.length + SNIPPET_CONTEXT_CHARS,
  );
  const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
};

/** case-insensitive; title matches rank above content matches, each group
 * sorted by recency */
export const searchScenes = (
  index: ScenesIndex,
  query: string,
): SceneSearchMatch[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const titleMatches: SceneSearchMatch[] = [];
  const contentMatches: SceneSearchMatch[] = [];
  for (const meta of index.scenes) {
    if (meta.name.toLowerCase().includes(normalizedQuery)) {
      titleMatches.push({ meta, snippet: null });
      continue;
    }
    for (const text of getSceneTexts(meta)) {
      const snippet = makeSnippet(text, normalizedQuery);
      if (snippet) {
        contentMatches.push({ meta, snippet });
        break;
      }
    }
  }
  const byRecency = (a: SceneSearchMatch, b: SceneSearchMatch) =>
    b.meta.updatedAt - a.meta.updatedAt;
  return [...titleMatches.sort(byRecency), ...contentMatches.sort(byRecency)];
};
