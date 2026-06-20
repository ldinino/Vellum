import { Titlebar } from "./components/Titlebar";
import { VellumShell } from "./components/VellumShell";
import { VellumProvider } from "./state/vellum";
import { ActiveEditorProvider } from "./state/activeEditor";

function App() {
  return (
    <div className="app-frame">
      <Titlebar title="Vellum" />
      <VellumProvider>
        <ActiveEditorProvider>
          <VellumShell />
        </ActiveEditorProvider>
      </VellumProvider>
    </div>
  );
}

export default App;
