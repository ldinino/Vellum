import { useEffect } from "react";
import { Titlebar } from "./components/Titlebar";
import { VellumShell } from "./components/VellumShell";
import { VellumProvider } from "./state/vellum";
import { ActiveEditorProvider } from "./state/activeEditor";
import { UpdaterProvider } from "./state/updater";
import { SyncSessionProvider } from "./state/syncSession";
import { useWindowMaximized } from "./components/useWindowMaximized";
import { installImageCopySupport } from "./lib/clipboard";

function App() {
  const maximized = useWindowMaximized();
  // Inline images are stored as notebook-relative paths, so a copy has to inline
  // them before another application can paste them.
  useEffect(() => installImageCopySupport(), []);
  return (
    <div className={`app-frame${maximized ? " app-frame--maximized" : ""}`}>
      <Titlebar title="Vellum" maximized={maximized} />
      <VellumProvider>
        <ActiveEditorProvider>
          <UpdaterProvider>
            <SyncSessionProvider>
              <VellumShell />
            </SyncSessionProvider>
          </UpdaterProvider>
        </ActiveEditorProvider>
      </VellumProvider>
    </div>
  );
}

export default App;
