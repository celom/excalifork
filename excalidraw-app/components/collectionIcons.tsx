/**
 * Curated set of editor icons a collection can use as its marker.
 *
 * `CollectionMeta.icon` stores the key; missing or unknown keys (e.g. from
 * an archive exported by a newer app version) fall back to the folder.
 */

import {
  LibraryIcon,
  MagicIcon,
  DeviceDesktopIcon,
  abacusIcon,
  adjustmentsIcon,
  boltIcon,
  brainIcon,
  codeIcon,
  coffeeIcon,
  eyeIcon,
  frameToolIcon,
  gridIcon,
  handIcon,
  historyIcon,
  magnetIcon,
  messageCircleIcon,
  microphoneIcon,
  paintIcon,
  pencilIcon,
  playerPlayIcon,
  presentationIcon,
  settingsIcon,
} from "@excalidraw/excalidraw/components/icons";

// tabler-icons: folder (no fitting icon in the editor package)
export const folderIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />
  </svg>
);

export const DEFAULT_COLLECTION_ICON = "folder";

export const COLLECTION_ICONS: {
  key: string;
  label: string;
  icon: React.ReactNode;
}[] = [
  { key: DEFAULT_COLLECTION_ICON, label: "Folder", icon: folderIcon },
  { key: "library", label: "Library", icon: LibraryIcon },
  { key: "presentation", label: "Presentation", icon: presentationIcon },
  { key: "frame", label: "Frame", icon: frameToolIcon },
  { key: "grid", label: "Grid", icon: gridIcon },
  { key: "code", label: "Code", icon: codeIcon },
  { key: "desktop", label: "Desktop", icon: DeviceDesktopIcon },
  { key: "settings", label: "Settings", icon: settingsIcon },
  { key: "adjustments", label: "Adjustments", icon: adjustmentsIcon },
  { key: "abacus", label: "Abacus", icon: abacusIcon },
  { key: "brain", label: "Brain", icon: brainIcon },
  { key: "bolt", label: "Bolt", icon: boltIcon },
  { key: "magic", label: "Magic", icon: MagicIcon },
  { key: "paint", label: "Paint", icon: paintIcon },
  { key: "pencil", label: "Pencil", icon: pencilIcon },
  { key: "eye", label: "Eye", icon: eyeIcon },
  { key: "message", label: "Chat", icon: messageCircleIcon },
  { key: "microphone", label: "Microphone", icon: microphoneIcon },
  { key: "play", label: "Play", icon: playerPlayIcon },
  { key: "history", label: "History", icon: historyIcon },
  { key: "hand", label: "Hand", icon: handIcon },
  { key: "coffee", label: "Coffee", icon: coffeeIcon },
  { key: "magnet", label: "Magnet", icon: magnetIcon },
];

const iconsByKey = new Map(
  COLLECTION_ICONS.map(({ key, icon }) => [key, icon]),
);

export const getCollectionIcon = (key: string | undefined | null) =>
  (key && iconsByKey.get(key)) || folderIcon;
