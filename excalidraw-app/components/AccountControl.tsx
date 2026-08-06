import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { useState } from "react";

import { useAtomValue } from "../app-jotai";
import { STORAGE_KEYS } from "../app_constants";
import {
  authErrorAtom,
  authStatusAtom,
  authUserAtom,
  isAuthAvailable,
  signInWithGoogle,
  signOutUser,
} from "../data/auth";
import { scenesIndexAtom } from "../scenes/state";

import "./AccountControl.scss";

/**
 * Account strip for the scenes sidebar — the primary entry point for signing
 * in. It sits here rather than in the main menu because cloud storage is about
 * the workspace, and this is the surface people are looking at when they think
 * about their scenes. (The `Sidebar.Header` above already carries the dock and
 * close buttons, so this is a row of its own rather than a header child.)
 *
 * Renders nothing at all unless `VITE_APP_ENABLE_AUTH` is set.
 */

/** enough scenes that "these only live on this device" is worth saying */
const NUDGE_MIN_SCENES = 3;

const loadNudgeDismissed = () => {
  try {
    return (
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_ACCOUNT_NUDGE_DISMISSED,
      ) === "true"
    );
  } catch {
    return false;
  }
};

// tabler-icons: cloud-up (no fitting icon in the editor package)
const cloudIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 18.004h-5.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 .995c1.488 1.188 2.162 3.007 1.77 4.769h.99c1.38 0 2.573 .813 3.129 1.986" />
    <path d="M19 22v-6" />
    <path d="M22 19l-3 -3l-3 3" />
  </svg>
);

export const AccountControl = () => {
  const status = useAtomValue(authStatusAtom);
  const user = useAtomValue(authUserAtom);
  const error = useAtomValue(authErrorAtom);
  const scenesIndex = useAtomValue(scenesIndexAtom);
  const [nudgeDismissed, setNudgeDismissed] = useState(loadNudgeDismissed);

  // "initializing" renders nothing rather than a placeholder: the session
  // restores in milliseconds and a flash of "sign in" for an already-signed-in
  // user is worse than a beat of nothing.
  if (
    !isAuthAvailable() ||
    status === "disabled" ||
    status === "initializing"
  ) {
    return null;
  }

  const dismissNudge = () => {
    setNudgeDismissed(true);
    try {
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_ACCOUNT_NUDGE_DISMISSED,
        "true",
      );
    } catch {
      // best-effort preference — a failure just means it shows again
    }
  };

  if (status === "signedOut" || !user) {
    const showNudge =
      !nudgeDismissed && scenesIndex.scenes.length >= NUDGE_MIN_SCENES;

    return (
      <div className="account-control">
        {showNudge && (
          <div className="account-control__nudge">
            <span>Sign in to reach these scenes from any device.</span>
            <button
              type="button"
              className="account-control__dismiss"
              onClick={dismissNudge}
              title="Dismiss"
              aria-label="Dismiss"
            >
              {CloseIcon}
            </button>
          </div>
        )}
        <button
          type="button"
          className="account-control__action"
          title="Sign in to sync your scenes across devices"
          onClick={() => signInWithGoogle()}
        >
          {cloudIcon}
          <span>Sign in with Google</span>
        </button>
        {error && <div className="account-control__error">{error}</div>}
      </div>
    );
  }

  const label = user.displayName || user.email || "Signed in";

  return (
    <div className="account-control">
      <div className="account-control__row">
        {user.photoURL ? (
          <img
            className="account-control__avatar"
            src={user.photoURL}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="account-control__avatar account-control__avatar--fallback">
            {label.slice(0, 1).toUpperCase()}
          </div>
        )}
        <span
          className="account-control__label"
          title={user.email ?? undefined}
        >
          {label}
        </span>
        <button
          type="button"
          className="account-control__signout"
          onClick={() => signOutUser()}
        >
          Sign out
        </button>
      </div>
      {error && <div className="account-control__error">{error}</div>}
    </div>
  );
};
