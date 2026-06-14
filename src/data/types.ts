// Shapes returned by the Rust commands (serde camelCase).

export interface Notebook {
  id: string;
  name: string;
  /** Folder under Documents\Vellum; may diverge from name after a rename. */
  folder: string;
  color: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface Section {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  pageTemplateId: string | null;
}

export interface Page {
  id: string;
  sectionId: string;
  title: string;
  sortOrder: number;
  updatedAt: string;
  /** First line of content, for the page-list preview. */
  preview: string;
}

export interface SearchFilters {
  /** Restrict to these notebooks; empty/absent = all. */
  notebookIds?: string[];
  sectionId?: string;
  dateField?: "created" | "modified";
  /** RFC3339 inclusive bounds. */
  dateFrom?: string;
  dateTo?: string;
  hasAttachment?: boolean;
}

export interface Attachment {
  id: string;
  pageId: string;
  filename: string;
  /** Notebook-relative path under attachments/<page-id>/. */
  path: string;
  mimeType: string | null;
  /** Bytes. */
  size: number;
}

export interface GrammarSpan {
  /** UTF-16 offsets into the submitted text (end exclusive). */
  start: number;
  end: number;
  message: string;
  /** Lint category (e.g. "Agreement", "Spelling") — the "Ignore Rule" identifier. */
  kind: string;
  /** Replacement strings; an empty string means "remove". */
  suggestions: string[];
}

/** Subset of app.json settings the frontend reads/writes in v1. */
export interface AppSettings {
  refineEnabled: boolean;
  grammarEnabled: boolean;
  spellcheckEnabled: boolean;
  defaultFont: string;
  defaultFontSize: number;
  refineAdherence: number;
  refineModelTier: string | null;
  grammarLanguage: string;
}

/** A page template (spec Section 7) — a pre-formatted Tiptap doc, stored in app.json. */
export interface PageTemplate {
  id: string;
  name: string;
  /** Tiptap document JSON. */
  contentJson: unknown;
  createdAt: string;
  updatedAt: string;
}

/** app.json. refineTemplates is passed through untouched until Phase 7. */
export interface AppConfig {
  settings: AppSettings;
  pageTemplates: PageTemplate[];
  refineTemplates: unknown[];
}

export interface SearchHit {
  pageId: string;
  notebookId: string;
  notebookName: string;
  sectionId: string;
  sectionName: string;
  title: string;
  /** Content excerpt; matched runs wrapped in U+0001 … U+0002. */
  snippet: string;
  createdAt: string;
  updatedAt: string;
  hasAttachment: boolean;
}
