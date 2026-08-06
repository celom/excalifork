/**
 * Google sign-in, for per-user cloud storage.
 *
 * Deliberately gated behind `VITE_APP_ENABLE_AUTH` rather than inferred from
 * the presence of a Firebase config. `.env.production` still ships upstream's
 * `excalidraw-room-persistence` project; this fork's own project is only
 * applied as a build arg (see `firebase-project/README.md`). Inferring
 * availability would mean a build that forgot the override renders a sign-in
 * button pointed at a project we don't control, and fails only once the user
 * clicks it — the same silent-fallback shape that broke share links once
 * already (see `docker-compose.selfhost.yml`). This fails closed instead.
 *
 * Nothing here initializes Firebase unless auth is enabled AND something asks
 * for it, so guest-only deployments never load the auth SDK at runtime.
 */

import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";

import { appJotaiStore, atom } from "../app-jotai";

import { getFirebaseApp, getFirebaseConfig } from "./firebase";

import type { Auth, User } from "firebase/auth";

export const isAuthEnabled = () =>
  import.meta.env.VITE_APP_ENABLE_AUTH === "true";

/**
 * Firebase projects belonging to upstream Excalidraw, shipped in `.env.*` and
 * used for collab-room persistence and share-link images. Those features work
 * anonymously, so the defaults are harmless for them — but Authentication
 * cannot be enabled on a project we don't own, and signing in against one
 * fails at click time with `auth/configuration-not-found`.
 */
const UPSTREAM_PROJECT_IDS = new Set([
  "excalidraw-oss-dev",
  "excalidraw-room-persistence",
]);

/**
 * Why auth cannot work with the current build config, or null if it can.
 *
 * `VITE_APP_ENABLE_AUTH` alone is not sufficient: it says "we want auth", not
 * "the config points at a project we control". Without this check the failure
 * surfaces only when a user clicks sign-in and gets a raw Firebase error.
 */
export const getAuthConfigError = (): string | null => {
  if (!isAuthEnabled()) {
    return null;
  }
  const projectId = getFirebaseConfig()?.projectId;
  if (!projectId) {
    return "VITE_APP_ENABLE_AUTH is set but VITE_APP_FIREBASE_CONFIG is missing or unparseable.";
  }
  if (UPSTREAM_PROJECT_IDS.has(projectId)) {
    return `VITE_APP_ENABLE_AUTH is set but VITE_APP_FIREBASE_CONFIG still points at upstream's "${projectId}" project. Override it with a Firebase project you control (see firebase-project/README.md).`;
  }
  return null;
};

/** auth is switched on AND the config can actually support it */
export const isAuthAvailable = () =>
  isAuthEnabled() && getAuthConfigError() === null;

/** the subset of the Firebase `User` the app actually renders or keys on */
export type AuthUser = {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
};

export type AuthStatus =
  /** `VITE_APP_ENABLE_AUTH` is not set — no auth UI is rendered at all */
  | "disabled"
  /** listener attached, first `onAuthStateChanged` not yet delivered */
  | "initializing"
  | "signedOut"
  | "signedIn";

export const authStatusAtom = atom<AuthStatus>(
  isAuthEnabled() ? "initializing" : "disabled",
);

export const authUserAtom = atom<AuthUser | null>(null);

/** last sign-in/sign-out failure, for surfacing in the account menu */
export const authErrorAtom = atom<string | null>(null);

let auth: Auth | null = null;

const _getAuth = () => {
  if (!auth) {
    auth = getAuth(getFirebaseApp());
  }
  return auth;
};

const toAuthUser = (user: User): AuthUser => ({
  uid: user.uid,
  displayName: user.displayName,
  email: user.email,
  photoURL: user.photoURL,
});

let unsubscribe: (() => void) | null = null;

/**
 * Attaches the auth-state listener. Idempotent — safe to call from an effect
 * that may re-run. Returns a teardown, or a no-op when auth is disabled.
 *
 * Firebase persists the session itself (IndexedDB), so a returning user is
 * restored here without any token handling on our side.
 */
export const initAuth = () => {
  const configError = getAuthConfigError();
  if (configError) {
    // loud, because the build looks configured but silently has no auth
    console.error(`[auth] disabled — ${configError}`);
    appJotaiStore.set(authStatusAtom, "disabled");
    return () => {};
  }
  if (!isAuthEnabled() || unsubscribe) {
    return () => {};
  }

  try {
    unsubscribe = onAuthStateChanged(
      _getAuth(),
      (user) => {
        appJotaiStore.set(authUserAtom, user ? toAuthUser(user) : null);
        appJotaiStore.set(authStatusAtom, user ? "signedIn" : "signedOut");
      },
      (error) => {
        console.error("auth state listener failed", error);
        appJotaiStore.set(authStatusAtom, "signedOut");
        appJotaiStore.set(authErrorAtom, error.message);
      },
    );
  } catch (error: any) {
    // a malformed/absent Firebase config throws here rather than at call time
    console.error("could not initialize auth", error);
    appJotaiStore.set(authStatusAtom, "disabled");
    return () => {};
  }

  return () => {
    unsubscribe?.();
    unsubscribe = null;
  };
};

/**
 * Firebase surfaces raw messages that don't say what to do. These three are
 * the setup mistakes that actually happen; anything else falls through.
 */
const describeSignInError = (error: any): string => {
  switch (error?.code) {
    case "auth/configuration-not-found":
      return "Sign-in isn't set up for this Firebase project yet — enable Authentication and the Google provider in the Firebase console.";
    case "auth/unauthorized-domain":
      return `This domain (${window.location.hostname}) isn't authorized for sign-in. Add it under Authentication → Settings → Authorized domains.`;
    case "auth/operation-not-allowed":
      return "The Google sign-in provider is disabled for this Firebase project. Enable it under Authentication → Sign-in method.";
    default:
      return error?.message ?? "Sign-in failed.";
  }
};

export const signInWithGoogle = async () => {
  appJotaiStore.set(authErrorAtom, null);
  try {
    await signInWithPopup(_getAuth(), new GoogleAuthProvider());
  } catch (error: any) {
    // closing the popup is a normal user action, not an error worth surfacing
    if (
      error?.code === "auth/popup-closed-by-user" ||
      error?.code === "auth/cancelled-popup-request"
    ) {
      return;
    }
    console.error("sign-in failed", error);
    appJotaiStore.set(authErrorAtom, describeSignInError(error));
  }
};

export const signOutUser = async () => {
  appJotaiStore.set(authErrorAtom, null);
  try {
    await signOut(_getAuth());
  } catch (error: any) {
    console.error("sign-out failed", error);
    appJotaiStore.set(authErrorAtom, error?.message ?? "Sign-out failed.");
  }
};

/** the signed-in uid, or null — for imperative (non-React) callers */
export const getCurrentUid = () => appJotaiStore.get(authUserAtom)?.uid ?? null;
