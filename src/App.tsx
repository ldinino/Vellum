import { Titlebar } from "./components/Titlebar";
import { VellumShell } from "./components/VellumShell";
import { VellumProvider } from "./state/vellum";
import { ActiveEditorProvider } from "./state/activeEditor";
import { UpdaterProvider } from "./state/updater";
import { useWindowMaximized } from "./components/useWindowMaximized";

function App() {
  const maximized = useWindowMaximized();
  return (
    <div className={`app-frame${maximized ? " app-frame--maximized" : ""}`}>
      <Titlebar title="Vellum" maximized={maximized} />
      <VellumProvider>
        <ActiveEditorProvider>
          <UpdaterProvider>
            <VellumShell />
          </UpdaterProvider>
        </ActiveEditorProvider>
      </VellumProvider>
    </div>
  );
}

export default App;
