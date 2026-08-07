import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import clsx from "clsx";
import { useState } from "react";

import { useAtomValue } from "../app-jotai";
import {
  authErrorAtom,
  authStatusAtom,
  authUserAtom,
  isAuthAvailable,
  signInWithGoogle,
  signOutUser,
} from "../data/auth";
import {
  cloudSyncErrorAtom,
  cloudSyncPendingAtom,
  cloudSyncStatusAtom,
} from "../scenes/cloudSync";
import {
  disableFolderSync,
  enableFolderSync,
  folderSyncErrorAtom,
  folderSyncFolderNameAtom,
  folderSyncStatusAtom,
  isFolderSyncSupported,
  reenableFolderSync,
} from "../scenes/folderSync";
import { scenesIndexAtom } from "../scenes/state";

import "./SceneDestinations.scss";

import type { ReactNode } from "react";

/**
 * The foot of the scenes sidebar: where the scenes are kept.
 *
 * Two destinations — a folder on this device, or a signed-in account — as two
 * lanes, of which at most one is ever lit. Sign-in lives here rather than in
 * the main menu because it is a storage decision, and the only way to make
 * "one or the other" legible is to show both choices in the same place, in the
 * same shape, so picking one visibly rules out the other.
 *
 * The lit rail on a lane's left edge is the single status channel: its colour
 * says which destination is live (and, when folder sync stalls, that it needs
 * attention). Unlit lanes preview their hue on hover, so the rail reads as the
 * commitment you are about to make.
 *
 * The account lane appears only when `VITE_APP_ENABLE_AUTH` is set and the
 * Firebase config can actually support sign-in; the folder lane only on
 * browsers with the File System Access API. With neither, this renders nothing.
 */

/** enough scenes that "these only live in this browser" is worth saying */
const COUNT_HINT_MIN_SCENES = 3;

// tabler-icons: folder-share (no fitting icon in the editor package)
const folderIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13 19h-8a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v4" />
    <path d="M16 22l5 -5" />
    <path d="M21 21.5v-4.5h-4.5" />
  </svg>
);

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

/** which hue the rail carries — destination identity, or a fault */
type LaneTone = "folder" | "account" | "warning" | "danger";

const Lane = ({
  tone,
  isLit,
  isBlocked,
  icon,
  name,
  detail,
  detailTitle,
  title,
  onClick,
  action,
}: {
  tone: LaneTone;
  /** this destination is the live one */
  isLit?: boolean;
  /** the other destination is live, so this one can't be picked */
  isBlocked?: boolean;
  icon: ReactNode;
  name: string;
  detail: string;
  detailTitle?: string;
  title: string;
  onClick?: () => void;
  action?: ReactNode;
}) => {
  const className = clsx(
    "scene-destinations__lane",
    `scene-destinations__lane--${tone}`,
    {
      "scene-destinations__lane--lit": isLit,
      "scene-destinations__lane--blocked": isBlocked,
    },
  );

  const body = (
    <>
      <span className="scene-destinations__rail" aria-hidden="true" />
      <span className="scene-destinations__icon">{icon}</span>
      <span className="scene-destinations__text">
        <span className="scene-destinations__name">{name}</span>
        <span className="scene-destinations__detail" title={detailTitle}>
          {detail}
        </span>
      </span>
      {action}
    </>
  );

  // a lit lane carries its own action button, so it can't be a button itself
  return isLit ? (
    <div className={className} title={title}>
      {body}
    </div>
  ) : (
    <button
      type="button"
      className={className}
      title={title}
      // aria-disabled rather than disabled: a blocked lane stays focusable so
      // a screen reader can reach the "one at a time" reason it carries
      aria-disabled={isBlocked || undefined}
      onClick={isBlocked ? undefined : onClick}
    >
      {body}
    </button>
  );
};

export const SceneDestinations = () => {
  const authStatus = useAtomValue(authStatusAtom);
  const user = useAtomValue(authUserAtom);
  const authError = useAtomValue(authErrorAtom);

  const folderStatus = useAtomValue(folderSyncStatusAtom);
  const folderError = useAtomValue(folderSyncErrorAtom);
  const folderName = useAtomValue(folderSyncFolderNameAtom);

  const cloudStatus = useAtomValue(cloudSyncStatusAtom);
  const cloudError = useAtomValue(cloudSyncErrorAtom);
  const cloudPending = useAtomValue(cloudSyncPendingAtom);

  const scenesIndex = useAtomValue(scenesIndexAtom);
  const [isConfirmingStop, setIsConfirmingStop] = useState(false);

  const hasAccountLane = isAuthAvailable() && authStatus !== "disabled";
  const hasFolderLane =
    isFolderSyncSupported() && folderStatus !== "unsupported";

  if (!hasAccountLane && !hasFolderLane) {
    return null;
  }

  const isFolderLit = hasFolderLane && folderStatus !== "off";
  const isAccountLit = hasAccountLane && authStatus === "signedIn" && !!user;

  // The session restores in milliseconds, and showing "sign in" to someone who
  // already is reads as being signed out. Wait it out — unless folder sync is
  // already lit, in which case the account lane renders blocked either way and
  // there is no wrong state to flash.
  if (hasAccountLane && authStatus === "initializing" && !isFolderLit) {
    return null;
  }

  const sceneCount = scenesIndex.scenes.length;
  const showCountHint =
    !isFolderLit && !isAccountLit && sceneCount >= COUNT_HINT_MIN_SCENES;

  const folderLane = () => {
    if (folderStatus === "active") {
      return (
        <Lane
          tone="folder"
          isLit
          icon={folderIcon}
          name={folderName ?? "Folder"}
          detail="Saving every change"
          title="Every scene is being written to this folder as a .excalidraw file"
          action={
            <button
              type="button"
              className="scene-destinations__action"
              onClick={() => setIsConfirmingStop(true)}
            >
              Stop
            </button>
          }
        />
      );
    }

    if (folderStatus === "needs-permission") {
      return (
        <Lane
          tone="warning"
          isLit
          icon={folderIcon}
          name={folderName ?? "Folder"}
          detail="Confirm access to continue"
          title="The browser needs you to re-confirm access to the sync folder"
          action={
            <button
              type="button"
              className="scene-destinations__action"
              onClick={() => reenableFolderSync()}
            >
              Resume
            </button>
          }
        />
      );
    }

    if (folderStatus === "error") {
      return (
        <Lane
          tone="danger"
          isLit
          icon={folderIcon}
          name="Folder sync failed"
          detail={folderError ?? "Writing to the folder failed."}
          detailTitle={folderError ?? undefined}
          title={folderError ?? "Writing to the folder failed."}
          // "Stop" rather than "Choose folder": a failed destination still
          // holds the lane, so the way out has to be release, not re-pick.
          // Otherwise a folder that's gone locks the account lane for good.
          // Re-picking is then one click on the folder lane it returns to.
          action={
            <button
              type="button"
              className="scene-destinations__action"
              onClick={() => disableFolderSync()}
            >
              Stop
            </button>
          }
        />
      );
    }

    return (
      <Lane
        tone="folder"
        isBlocked={isAccountLit}
        icon={folderIcon}
        name="A folder"
        detail={
          isAccountLit ? "One destination at a time" : "Files on this device"
        }
        title={
          isAccountLit
            ? "Sign out to keep your scenes in a folder instead"
            : "Continuously save all scenes as .excalidraw files into a folder you pick"
        }
        onClick={() => enableFolderSync()}
      />
    );
  };

  // what the lit account lane says about the sync itself. The email is one
  // tap away in the tooltip; the line the user needs on sight is whether
  // their scenes are actually somewhere else yet.
  const accountDetail = () => {
    if (cloudStatus === "error") {
      return cloudError ?? "Sync failed.";
    }
    if (cloudStatus === "syncing") {
      return "Syncing…";
    }
    if (cloudPending > 0) {
      return `Synced — ${cloudPending} to download`;
    }
    return "Saving every change";
  };

  const accountLane = () => {
    if (isAccountLit && user) {
      const name = user.displayName || user.email || "Signed in";
      const detail = accountDetail();
      return (
        <Lane
          tone={cloudStatus === "error" ? "danger" : "account"}
          isLit
          icon={
            user.photoURL ? (
              <img
                className="scene-destinations__avatar"
                src={user.photoURL}
                alt=""
                referrerPolicy="no-referrer"
              />
            ) : (
              cloudIcon
            )
          }
          name={name}
          detail={detail}
          detailTitle={cloudError ?? user.email ?? undefined}
          title={
            cloudPending > 0
              ? `${cloudPending} scene${
                  cloudPending === 1 ? "" : "s"
                } from this account will download when you open them`
              : cloudError ?? user.email ?? "Signed in"
          }
          action={
            <button
              type="button"
              className="scene-destinations__action"
              onClick={() => signOutUser()}
            >
              Sign out
            </button>
          }
        />
      );
    }

    return (
      <Lane
        tone="account"
        isBlocked={isFolderLit}
        icon={cloudIcon}
        name="Online account"
        detail={
          isFolderLit ? "One destination at a time" : "Sign in with Google"
        }
        title={
          isFolderLit
            ? "Stop folder sync to keep your scenes in an online account instead"
            : "Sign in with Google to keep your scenes in an online account"
        }
        onClick={() => signInWithGoogle()}
      />
    );
  };

  // folder-sync failures always arrive with the "error" status, so the lane
  // itself carries them; only sign-in fails without a lane to say so
  return (
    <div className="scene-destinations">
      <div className="scene-destinations__eyebrow">Store your folio</div>
      {showCountHint && (
        <div className="scene-destinations__hint">
          {sceneCount} scenes, kept in this browser only
        </div>
      )}
      {hasFolderLane && folderLane()}
      {hasAccountLane && accountLane()}
      {authError && (
        <div className="scene-destinations__error">{authError}</div>
      )}
      {isConfirmingStop && (
        <ConfirmDialog
          title="Stop folder sync"
          onConfirm={() => {
            disableFolderSync();
            setIsConfirmingStop(false);
          }}
          onCancel={() => setIsConfirmingStop(false)}
        >
          <p>
            Scenes will no longer be saved to the folder. Files already written
            are kept on disk.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
};
