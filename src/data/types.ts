// Shapes returned by the Rust commands (serde camelCase).

export interface Notebook {
  id: string;
  name: string;
  /** Folder under Documents\Vellum; may diverge from name after a rename. */
  folder: string;
  color: string | null;
  sortOrder: number;
  createdAt: string;
  /** Soft-delete timestamp (RFC3339) while in the Recycle Bin; absent when live. */
  deletedAt?: string | null;
}

/** Page sort preference for a section (spec Section 5 / Phase 9). */
export type PageSortMode = "custom" | "created" | "modified";
export type PageSortDir = "asc" | "desc";

export interface Section {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  pageTemplateId: string | null;
  /** "custom" = drag-reorder order; "created"/"modified" sort by timestamp. */
  pageSortMode: PageSortMode;
  /** "asc" | "desc" (ignored for "custom"). */
  pageSortDir: PageSortDir;
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

/** One entry in the global Recycle Bin (spec Section 5.1) — a soft-deleted
 * notebook, section, page, or attachment, with context for display + restore. */
export interface RecycleItem {
  kind: "notebook" | "section" | "page" | "attachment";
  id: string;
  notebookId: string;
  notebookName: string;
  /** Notebook/section name, page title, or attachment filename. */
  name: string;
  /** Breadcrumb of where it lived (notebook, section, or "section / page"). */
  parent: string | null;
  /** Bytes (attachments only). */
  size: number | null;
  deletedAt: string;
}

export interface GrammarSpan {
  /** UTF-16 offsets into the submitted text (end exclusive). */
  start: number;
  end: number;
  message: string;
  /** Lint category (e.g. "Agreement", "Spelling") — the "Ignore Rule" identifier. */
  kind: string;
  /** True for misspellings: rendered with a distinct underline + spelling menu
   * and gated on the spell-check toggle rather than the grammar toggle. */
  isSpelling: boolean;
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
  /** Strict (0.0) .. Liberal (1.0) global default. */
  refineAdherence: number;
  /** "Fast" | "Balanced" | "Thorough"; null until a tier is chosen. */
  refineModelTier: string | null;
  grammarLanguage: string;
  /** Cleared until the user finishes the first-run setup screen. */
  firstRunComplete: boolean;
  /** Set once the starter Refine templates have been seeded (Phase 8). */
  startersSeeded: boolean;
  /** Set once the first-launch "Welcome to Vellum" notebook has been seeded
   * (Phase 11); ensures it is created exactly once and never recreated. */
  welcomeSeeded: boolean;
  /** Words the user added to the Harper spell-check dictionary (spec Section 10). */
  customDictionary: string[];
  /** Grammar lint categories the user chose to ignore via "Ignore this rule". */
  ignoredGrammarRules: string[];
}

/** App + component versions shown in Settings → About (spec Section 15). */
export interface VersionInfo {
  app: string;
  harper: string;
  ollama: string;
}

/** One diagnostic log entry (Settings → About; spec Phase 11). */
export interface LogEntry {
  /** RFC 3339, local time. */
  timestamp: string;
  level: "error" | "warn" | "info";
  /** Short subsystem tag (e.g. "ollama", "db", "runtime", "ui"). */
  area: string;
  message: string;
}

/** Filesystem locations resolved by the backend (Settings → General). */
export interface AppPaths {
  dataDir: string;
  runtimeDir: string;
}

/** One file copied next to an exported page (an inline image or an attachment). */
export interface ExportCopy {
  /** Notebook-relative source path. */
  srcRel: string;
  /** Filename within the export's sibling files folder. */
  destName: string;
}

/** One page in a multi-page Markdown export (execution-plan #6). */
export interface ExportPageEntry {
  /** Path relative to the export root, e.g. `Notebook/Section/Page.md`. */
  relPath: string;
  /** Rendered Markdown body. */
  markdown: string;
  /** Files to copy into the single shared attachments folder. */
  copies: ExportCopy[];
}

/** One few-shot example pair rendered into the harness (spec Section 8). */
export interface ExamplePair {
  input: string;
  output: string;
}

/** A Refine template (spec Section 8) — transformation rules + optional
 * few-shot examples, stored in app.json. */
export interface RefineTemplate {
  id: string;
  name: string;
  /** The transformation rules (was `systemPrompt` pre-Phase 8). */
  instructions: string;
  /** Few-shot input/output pairs rendered into the harness. */
  examples: ExamplePair[];
  description: string | null;
  /** Overrides the global Strict..Liberal setting for this template when set. */
  adherenceOverride: number | null;
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

/** app.json — app-level config (settings + template libraries). */
export interface AppConfig {
  settings: AppSettings;
  pageTemplates: PageTemplate[];
  refineTemplates: RefineTemplate[];
}

// --- Refine infrastructure (spec Sections 8, 9 / Phase 7) -------------------

/** A model tier entry from the bundled manifest. */
export interface ManifestTier {
  /** "Fast" | "Balanced" | "Thorough". */
  id: string;
  /** Ollama model identifier, e.g. "qwen3:14b". */
  model: string;
  /** Approximate download size shown before pulling, e.g. "~9 GB". */
  sizeLabel: string;
  /** Recommended system RAM, e.g. "16 GB". */
  targetRamLabel: string;
  /** One-line guidance on when the tier fits. */
  useFor: string;
  /** Lighter model for tight memory (Phase 8 auto-selection). */
  fallback: { model: string; sizeLabel: string } | null;
}

/** An installed Ollama model (from /api/tags). */
export interface InstalledModel {
  name: string;
  sizeBytes: number;
}

/** The bundled models.json manifest. */
export interface Manifest {
  schemaVersion: number;
  ollama: { version: string; url: string; sha256: string; sizeBytes: number };
  tiers: ManifestTier[];
  thresholds: {
    discreteMinVramBytes: number;
    discreteBalancedMinVramBytes: number;
    discreteThoroughMinVramBytes: number;
    integratedBalancedMinRamBytes: number;
  };
}

export interface GpuAdapter {
  description: string;
  dedicatedVideoMemory: number;
  dedicatedSystemMemory: number;
  sharedSystemMemory: number;
  vendorId: number;
  isBasicRenderDriver: boolean;
}

/** Detected hardware + a recommended tier (spec Section 9, "Model tiers"). */
export interface DetectedHardware {
  totalRamBytes: number;
  gpus: GpuAdapter[];
  cpuOnly: boolean;
  /** "Fast" | "Balanced" | "Thorough". */
  recommendedTier: string;
  /** "discrete" | "integrated" | "none". */
  gpuKind: string;
  /** Non-null only on CPU-only machines. */
  warning: string | null;
}

export interface RuntimeStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

/** Payload of the `refine://runtime-progress` event. */
export interface RuntimeProgress {
  /** "downloading" | "verifying" | "extracting" | "done" | "error". */
  phase: string;
  downloadedBytes: number;
  totalBytes: number | null;
  attempt: number;
  message: string | null;
}

/** Payload of the `refine://model-progress` event. */
export interface ModelProgress {
  model: string;
  status: string;
  digest: string | null;
  completedBytes: number | null;
  totalBytes: number | null;
  done: boolean;
}

export interface ProcessStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
}

/** Debug-panel generate request (spec Section 9, "Debug panel"). */
export interface DebugGenerateRequest {
  model: string;
  systemPrompt: string | null;
  userText: string;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  numPredict: number | null;
  numCtx: number | null;
}

export interface DebugGenerateResult {
  requestPreview: string;
  responseText: string;
  ttftMs: number;
  totalMs: number;
  evalCount: number | null;
  model: string;
}

/** Refine request (spec Sections 8–9, Phase 8). `adherence` is 0 (Strict) .. 1
 * (Liberal), already resolved from the template override or global default. */
export interface RefineRequest {
  text: string;
  instructions: string;
  examples: ExamplePair[];
  adherence: number;
}

export interface RefineResult {
  /** Cleaned transformed text (reasoning stripped); may be Markdown. */
  text: string;
  /** The model that actually ran (may be the tier's lighter fallback). */
  model: string;
  ttftMs: number;
  totalMs: number;
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
  /** Filenames of the page's attachments (no MIME). The UI highlights those
   * matching the query so a filename hit isn't shown as just a paperclip. */
  attachmentFilenames: string[];
}
