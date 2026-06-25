/**
 * Settings → Proofing (spec Section 10): manage Harper's spell/grammar checks.
 * Lets the user toggle each check, maintain a custom dictionary (the persistent,
 * reversible home for words added via "Add to Dictionary"), and review/undo the
 * grammar rules they hid with "Ignore this rule". One-off "Ignore once"
 * dismissals are intentionally temporary (they reset on restart) and not listed.
 */

import { useState } from "react";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Toggle } from "../ui/Toggle";
import { useVellum } from "../../state/vellum";
import "./ProofingSettings.css";

export function ProofingSettings() {
  const { grammarEnabled, spellcheckEnabled, customDictionary, ignoredGrammarRules, actions } =
    useVellum();
  const [draft, setDraft] = useState("");

  const addWord = () => {
    const w = draft.trim();
    if (!w) return;
    void actions.addDictionaryWord(w);
    setDraft("");
  };

  const words = [...customDictionary].sort((a, b) => a.localeCompare(b));
  const rules = [...ignoredGrammarRules].sort((a, b) => a.localeCompare(b));

  return (
    <div className="v-proofing">
      <section className="v-proofing__section">
        <h3 className="v-proofing__heading">Checking</h3>
        <div className="v-proofing__toggle">
          <Toggle checked={spellcheckEnabled} onChange={actions.setSpellcheckEnabled} />
          <div>
            <span className="v-proofing__toggle-label">Check spelling</span>
            <span className="v-proofing__hint">
              Underlines misspelled words in red. Suggestions and “Add to Dictionary” appear on
              hover or right-click.
            </span>
          </div>
        </div>
        <div className="v-proofing__toggle">
          <Toggle checked={grammarEnabled} onChange={actions.setGrammarEnabled} />
          <div>
            <span className="v-proofing__toggle-label">Check grammar</span>
            <span className="v-proofing__hint">
              Underlines grammar issues in green. Right-click an underline to accept a fix or
              ignore the rule.
            </span>
          </div>
        </div>
      </section>

      <section className="v-proofing__section">
        <h3 className="v-proofing__heading">Custom dictionary</h3>
        <p className="v-proofing__hint">
          Words here are never flagged as misspelled — this is where “Add to Dictionary” keeps
          them. Remove a word to start flagging it again.
        </p>
        <div className="v-proofing__add">
          <input
            className="v-proofing__input"
            type="text"
            value={draft}
            placeholder="Add a word…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addWord();
              }
            }}
          />
          <Button icon="book--plus" onClick={addWord} disabled={!draft.trim()}>
            Add
          </Button>
        </div>
        {words.length === 0 ? (
          <p className="v-proofing__empty">No words added yet.</p>
        ) : (
          <ul className="v-proofing__list">
            {words.map((w) => (
              <li key={w} className="v-proofing__item">
                <span className="v-proofing__word">{w}</span>
                <button
                  type="button"
                  className="v-proofing__remove"
                  title={`Remove “${w}”`}
                  aria-label={`Remove ${w}`}
                  onClick={() => void actions.removeDictionaryWord(w)}
                >
                  <Icon name="cross-small" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="v-proofing__section">
        <h3 className="v-proofing__heading">Ignored grammar rules</h3>
        <p className="v-proofing__hint">
          Rules you hid with “Ignore this rule”. Remove one to show those underlines again. (One-off
          “Ignore once” dismissals are temporary and reset when you restart Vellum.)
        </p>
        {rules.length === 0 ? (
          <p className="v-proofing__empty">No rules ignored.</p>
        ) : (
          <ul className="v-proofing__list">
            {rules.map((k) => (
              <li key={k} className="v-proofing__item">
                <span className="v-proofing__word">{k}</span>
                <button
                  type="button"
                  className="v-proofing__remove"
                  title={`Stop ignoring “${k}”`}
                  aria-label={`Stop ignoring ${k}`}
                  onClick={() => void actions.unignoreGrammarRule(k)}
                >
                  <Icon name="cross-small" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
