import { Titlebar } from "./components/Titlebar";
import { VellumShell } from "./components/VellumShell";
import { VellumProvider } from "./state/vellum";

function App() {
  return (
    <div className="app-frame">
      <Titlebar title="Vellum" />
      <VellumProvider>
        <VellumShell />
      </VellumProvider>
    </div>
  );
}

export default App;
