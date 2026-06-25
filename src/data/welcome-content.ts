/**
 * First-launch welcome content (spec Phase 11).
 *
 * The "Welcome to Vellum" notebook seeded on first launch: one section per
 * topic, each with a single page. Pages are authored as plain HTML here and
 * converted to the editor's document JSON at seed time with `generateJSON` —
 * using the *same* extension set the live editor uses, so every node and mark
 * round-trips. See `seedWelcomeNotebook` in src/state/vellum.tsx.
 *
 * Note: the Refine page never uses the word "AI" — the feature is framed as an
 * editing tool (spec Section 9).
 */

import { generateJSON } from "@tiptap/react";
import { buildExtensions } from "../components/editor/extensions";

/** Display name of the notebook seeded on first launch. */
export const WELCOME_NOTEBOOK_NAME = "Welcome to Vellum";

interface WelcomeTopic {
  /** Section tab name. */
  sectionName: string;
  /** The single page's title. */
  pageTitle: string;
  /** Short plain-text snippet shown in the page list. */
  preview: string;
  /** Page body as HTML; converted to the editor document JSON at seed time. */
  html: string;
}

const TOPICS: WelcomeTopic[] = [
  {
    sectionName: "Welcome",
    pageTitle: "Welcome to Vellum",
    preview:
      "Vellum keeps your notes on your computer. Here's how notebooks, sections, and pages fit together.",
    html: `
      <h1>Welcome to Vellum</h1>
      <p>Vellum is a notebook for your notes, with a classic, comfortable look. Everything you write stays on your computer — your notes are never sent to the cloud by Vellum.</p>
      <h2>How Vellum is organized</h2>
      <p>Three simple levels, just like a paper binder:</p>
      <ul>
        <li><strong>Notebooks</strong> live in the panel on the left.</li>
        <li><strong>Sections</strong> are the colored tabs across the top of a notebook. (This notebook has four: Welcome, Editing &amp; Features, Refine, and Settings &amp; Tips.)</li>
        <li><strong>Pages</strong> are listed on the right; each section holds as many pages as you like.</li>
      </ul>
      <h2>Getting around</h2>
      <ul>
        <li>Click a notebook on the left to open it, then pick a section tab and a page.</li>
        <li>Add a notebook with <strong>New Notebook</strong>, a section with the <strong>+</strong> tab, and a page with <strong>New Page</strong>.</li>
        <li>Rename almost anything by double-clicking it.</li>
      </ul>
      <h2>Nothing is lost by accident</h2>
      <p>Deleting a notebook, section, page, or attachment moves it to the <strong>Recycle Bin</strong> in the lower-left corner, where you can restore it. Items are only gone for good when you empty the bin.</p>
      <hr>
      <p><em>New here? Read the other three sections of this notebook to learn the editor, the Refine writing assistant, and where your settings and data live.</em></p>
    `,
  },
  {
    sectionName: "Editing & Features",
    pageTitle: "Editing & Features",
    preview:
      "The editor, formatting, images, attachments, links, search, spelling & grammar, export, and print.",
    html: `
      <h1>Editing &amp; Features</h1>
      <p>Vellum's editor works like a familiar word processor. The toolbar above the page holds everything you need.</p>
      <h2>Formatting</h2>
      <ul>
        <li><strong>Bold</strong>, <em>italic</em>, underline, and strikethrough.</li>
        <li>Headings, bullet and numbered lists, quotes, and code.</li>
        <li>Text color, highlight, font and size, alignment, and tables.</li>
        <li>Superscript and subscript for footnotes and formulas.</li>
      </ul>
      <h2>Images &amp; attachments</h2>
      <ul>
        <li><strong>Images:</strong> paste or drag a picture straight onto the page, then drag its corner to resize.</li>
        <li><strong>Files:</strong> drag any file onto the page to attach it. Attachments appear in the bar at the bottom of the page.</li>
      </ul>
      <h2>Links</h2>
      <p>Paste a web address to turn it into a link. To open a link, hold <code>Ctrl</code> and click it, or right-click and choose <strong>Open Link</strong>.</p>
      <h2>Finding things</h2>
      <ul>
        <li><strong>Find on this page:</strong> press <code>Ctrl</code>+<code>F</code>.</li>
        <li><strong>Search everything:</strong> the search box looks across every notebook — page text and attachment names included.</li>
      </ul>
      <h2>Spelling &amp; grammar</h2>
      <p>Misspellings and grammar issues are underlined as you type, completely offline (English in this version). Right-click an underline to see suggestions, add a word to your dictionary, or ignore a rule.</p>
      <h2>Templates, export &amp; print</h2>
      <ul>
        <li><strong>Page templates:</strong> reuse a page layout for new pages (manage them in Settings).</li>
        <li><strong>Export:</strong> <strong>File ▸ Export Page as Markdown</strong> saves the page — and its attachments — to disk.</li>
        <li><strong>Print:</strong> <strong>File ▸ Print</strong> or <code>Ctrl</code>+<code>P</code>.</li>
      </ul>
    `,
  },
  {
    sectionName: "Refine",
    pageTitle: "Refine",
    preview:
      "Refine polishes selected text, privately and offline. How to turn it on and use it.",
    html: `
      <h1>Refine</h1>
      <p><strong>Refine</strong> is a writing assistant that polishes the text you select — fix spelling and grammar, tighten wording, or adjust the tone. It runs entirely on your own computer.</p>
      <h2>Private by design</h2>
      <p>Nothing you write is sent anywhere. Refine works offline, on your machine, every time.</p>
      <h2>Turning it on</h2>
      <p>Refine is <strong>off by default</strong>. Enable it in <strong>Settings ▸ Refine</strong>. The first time you turn it on, Vellum downloads a local engine and a model sized to your computer; after that it works without a connection.</p>
      <h2>Using Refine</h2>
      <ol>
        <li>Select the text you want to improve.</li>
        <li>Right-click and choose <strong>Refine</strong>, then pick a template (for example, "Fix spelling &amp; grammar" or "Make concise").</li>
        <li>Vellum shows a <strong>preview</strong> of the change — your text is never altered until you accept it.</li>
      </ol>
      <h2>Make it yours</h2>
      <ul>
        <li><strong>Templates:</strong> start from the built-in ones or create your own in <strong>Settings ▸ Refine ▸ Templates</strong>.</li>
        <li><strong>Adherence:</strong> the <em>Strict ↔ Liberal</em> control decides whether Refine follows the template exactly or reorganizes more freely for clarity.</li>
        <li><strong>Model:</strong> Vellum suggests a model based on your hardware; you can change it in Settings. Without a capable graphics card Refine still works, just more slowly.</li>
      </ul>
    `,
  },
  {
    sectionName: "Settings & Tips",
    pageTitle: "Settings & Tips",
    preview:
      "The Settings tabs, handy keyboard shortcuts, and where your notes are stored.",
    html: `
      <h1>Settings &amp; Tips</h1>
      <p>Open <strong>Settings</strong> from the <strong>Tools</strong> menu. It's organized into tabs:</p>
      <h2>The Settings tabs</h2>
      <ul>
        <li><strong>General</strong> — shows where your notes are stored, with a button to open that folder.</li>
        <li><strong>Page Templates</strong> — create and manage reusable page layouts.</li>
        <li><strong>Editor</strong> — set the default font and size for new pages.</li>
        <li><strong>Proofing</strong> — turn spelling and grammar check on or off, and manage your custom dictionary and ignored rules.</li>
        <li><strong>Refine</strong> — enable Refine, choose a model, and manage templates.</li>
        <li><strong>About</strong> — version information and updates.</li>
      </ul>
      <h2>Handy shortcuts</h2>
      <ul>
        <li><code>Ctrl</code>+<code>B</code> / <code>I</code> / <code>U</code> — bold, italic, underline.</li>
        <li><code>Ctrl</code>+<code>F</code> — find on the page.</li>
        <li><code>Ctrl</code>+<code>P</code> — print.</li>
        <li><code>Ctrl</code>+<code>Z</code> / <code>Ctrl</code>+<code>Y</code> — undo and redo.</li>
      </ul>
      <h2>Where your notes live</h2>
      <p>Everything is stored in a normal folder on your PC (<strong>Documents ▸ Vellum</strong>). Because it's an ordinary folder, a backup or sync tool like OneDrive can keep a copy, and <strong>reinstalling Vellum keeps all your notebooks</strong>.</p>
      <hr>
      <p><em>Finished exploring? You can delete this "Welcome to Vellum" notebook whenever you like — it won't come back.</em></p>
    `,
  },
];

/** One ready-to-save page per topic: the editor document JSON (stringified) and
 * a page-list preview. Converted from HTML with the same extension set the
 * editor uses, so every node/mark round-trips. Called once, at first-launch seed. */
export function buildWelcomePages(): {
  sectionName: string;
  pageTitle: string;
  preview: string;
  contentJson: string;
}[] {
  const extensions = buildExtensions();
  return TOPICS.map((t) => ({
    sectionName: t.sectionName,
    pageTitle: t.pageTitle,
    preview: t.preview,
    contentJson: JSON.stringify(generateJSON(t.html, extensions)),
  }));
}
