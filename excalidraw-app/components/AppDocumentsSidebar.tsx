import { Sidebar } from "@excalidraw/excalidraw";

import { DocumentsTab } from "./DocumentsTab";

export const DOCUMENTS_SIDEBAR_NAME = "documents";

export const AppDocumentsSidebar = () => {
  return (
    <Sidebar name={DOCUMENTS_SIDEBAR_NAME} position="left">
      <Sidebar.Header />
      <DocumentsTab />
    </Sidebar>
  );
};
