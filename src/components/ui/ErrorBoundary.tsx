/**
 * Catches render-time exceptions so one broken component shows a recoverable
 * message instead of blanking the whole window (which previously forced a
 * relaunch). React error boundaries must be class components.
 *
 * Place a top-level boundary as the last-resort net, and tighter ones around
 * independently-recoverable regions (Settings panel, editor) so a crash there is
 * contained and the rest of the app keeps working. Pass `resetKeys` to clear the
 * error automatically on navigation (e.g. switching tab/page).
 */

import { Component, ErrorInfo, ReactNode } from "react";
import { Button } from "./Button";
import "./ErrorBoundary.css";

interface Props {
  children: ReactNode;
  /** Re-render children (clear the caught error) when any of these change. */
  resetKeys?: unknown[];
  /** Custom fallback; defaults to a themed message with Try again / Reload. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Heading shown in the default fallback, e.g. "Settings". */
  label?: string;
}

interface State {
  error: Error | null;
}

function keysChanged(a: unknown[] = [], b: unknown[] = []): boolean {
  return a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="v-errbound" role="alert">
        <div className="v-errbound__box">
          <h2 className="v-errbound__title">
            {this.props.label ? `${this.props.label} hit a problem` : "Something went wrong"}
          </h2>
          <p className="v-errbound__msg">{error.message || String(error)}</p>
          <div className="v-errbound__actions">
            <Button onClick={this.reset}>Try again</Button>
            <Button accent onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
