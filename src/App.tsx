import { Titlebar } from "./components/Titlebar";
import { VellumShell } from "./components/VellumShell";
import { VellumProvider } from "./state/vellum";
import { ActiveEditorProvider } from "./state/activeEditor";
import { useWindowMaximized } from "./components/useWindowMaximized";

function App() {
  const maximized = useWindowMaximized();
  return (
    <div className={`app-frame${maximized ? " app-frame--maximized" : ""}`}>
      <Titlebar title="Vellum" maximized={maximized} />
      <VellumProvider>
        <ActiveEditorProvider>
          <VellumShell />
        </ActiveEditorProvider>
      </VellumProvider>
    </div>
  );
}

export default App;
