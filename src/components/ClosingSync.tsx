/**
 * Shown while a final sync runs during shutdown.
 *
 * Closing without pushing would silently strand a session's work on this
 * device, so the window is held open until the upload finishes. That is only
 * acceptable if it is visible and escapable: a person must never be trapped by
 * a stalled network, so Close anyway is always available and the failure case
 * says what happened rather than closing quietly.
 */

import "./ClosingSync.css";

export function ClosingSync({
  state,
  error,
  onCloseAnyway,
  onRetry,
}: {
  state: "syncing" | "failed";
  error: string | null;
  onCloseAnyway: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="v-closing" role="alertdialog" aria-live="polite">
      <div className="v-closing__box">
        {state === "syncing" ? (
          <>
            <h2 className="v-closing__title">Finishing sync…</h2>
            <p className="v-closing__text">
              Sending this session&apos;s changes to your storage. Vellum will close on its own
              when it&apos;s done.
            </p>
          </>
        ) : (
          <>
            <h2 className="v-closing__title">Couldn&apos;t finish syncing</h2>
            <p className="v-closing__text">
              {error ?? "The sync didn't complete."} Your notebooks are safe on this device and
              will sync next time.
            </p>
          </>
        )}
        <div className="v-closing__actions">
          {state === "failed" && (
            <button type="button" className="v-button" onClick={onRetry}>
              Try again
            </button>
          )}
          <button type="button" className="v-button" onClick={onCloseAnyway}>
            Close anyway
          </button>
        </div>
      </div>
    </div>
  );
}
