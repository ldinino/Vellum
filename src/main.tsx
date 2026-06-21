import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
// 7.css scoped build: styles apply only inside .win7 wrappers, so it serves
// as a reference/base without leaking into bespoke components.
import "7.css/dist/7.scoped.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
