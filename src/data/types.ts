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
  /** Strict (0.0) .. Liberal (1.0) global default. */
  refineAdherence: number;
  /** "Fast" | "Balanced" | "Thorough"; null until a tier is chosen. */
  refineModelTier: string | null;
  grammarLanguage: string;
  /** Cleared until the user finishes the first-run setup screen. */
  firstRunComplete: boolean;
}

/** A Refine template (spec Section 8) — a named system prompt, stored in app.json. */
export interface RefineTemplate {
  id: string;
  name: string;
  systemPrompt: string;
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
  /** Ollama model identifier, e.g. "qwen2.5:7b". */
  model: string;
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
