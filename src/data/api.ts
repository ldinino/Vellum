// Thin wrappers over the Rust commands. Argument keys are camelCase; Tauri v2
// maps them to the snake_case Rust parameters automatically.

import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  Attachment,
  DebugGenerateRequest,
  DebugGenerateResult,
  DetectedHardware,
  GrammarSpan,
  InstalledModel,
  Manifest,
  Notebook,
  Page,
  PageSortDir,
  PageSortMode,
  ProcessStatus,
  RefineRequest,
  RefineResult,
  RuntimeStatus,
  Section,
  SearchFilters,
  SearchHit,
} from "./types";

// --- App config (app.json) --------------------------------------------------

export const getAppConfig = () => invoke<AppConfig>("get_app_config");

export const saveAppConfig = (config: AppConfig) =>
  invoke<void>("save_app_config", { config });

// --- Grammar (Harper, spec Section 10) --------------------------------------

/** Lint plain text; offsets are UTF-16 code units into `text`. */
export const grammarCheck = (text: string) =>
  invoke<GrammarSpan[]>("grammar_check", { text });

// --- Notebooks (notebooks.json registry) -----------------------------------

export const listNotebooks = () => invoke<Notebook[]>("list_notebooks");

export const createNotebook = (name: string) =>
  invoke<Notebook>("create_notebook", { name });

export const renameNotebook = (notebookId: string, name: string) =>
  invoke<Notebook>("rename_notebook", { notebookId, name });

export const setNotebookColor = (notebookId: string, color: string | null) =>
  invoke<void>("set_notebook_color", { notebookId, color });

export const deleteNotebook = (notebookId: string) =>
  invoke<void>("delete_notebook", { notebookId });

export const reorderNotebooks = (orderedIds: string[]) =>
  invoke<void>("reorder_notebooks", { orderedIds });

// --- Sections (per-notebook DB) ---------------------------------------------

export const listSections = (notebookId: string) =>
  invoke<Section[]>("list_sections", { notebookId });

export const createSection = (notebookId: string, name: string) =>
  invoke<Section>("create_section", { notebookId, name });

export const renameSection = (notebookId: string, sectionId: string, name: string) =>
  invoke<void>("rename_section", { notebookId, sectionId, name });

export const updateSection = (
  notebookId: string,
  sectionId: string,
  name: string,
  color: string | null,
  pageTemplateId: string | null,
) => invoke<void>("update_section", { notebookId, sectionId, name, color, pageTemplateId });

export const deleteSection = (notebookId: string, sectionId: string) =>
  invoke<void>("delete_section", { notebookId, sectionId });

export const reorderSections = (notebookId: string, orderedIds: string[]) =>
  invoke<void>("reorder_sections", { notebookId, orderedIds });

/** Persist a section's page sort preference (spec Section 5 / Phase 9). */
export const setSectionSort = (
  notebookId: string,
  sectionId: string,
  mode: PageSortMode,
  dir: PageSortDir,
) => invoke<void>("set_section_sort", { notebookId, sectionId, mode, dir });

// --- Pages (per-notebook DB) ------------------------------------------------

export const listPages = (notebookId: string, sectionId: string) =>
  invoke<Page[]>("list_pages", { notebookId, sectionId });

export const createPage = (notebookId: string, sectionId: string, title: string) =>
  invoke<Page>("create_page", { notebookId, sectionId, title });

export const setPageTitle = (notebookId: string, pageId: string, title: string) =>
  invoke<void>("set_page_title", { notebookId, pageId, title });

export const deletePage = (notebookId: string, pageId: string) =>
  invoke<void>("delete_page", { notebookId, pageId });

export const duplicatePage = (notebookId: string, pageId: string) =>
  invoke<Page>("duplicate_page", { notebookId, pageId });

export const movePage = (notebookId: string, pageId: string, toSectionId: string) =>
  invoke<void>("move_page", { notebookId, pageId, toSectionId });

export const reorderPages = (notebookId: string, orderedIds: string[]) =>
  invoke<void>("reorder_pages", { notebookId, orderedIds });

// --- Page content / auto-save -----------------------------------------------

/** Freshest saved doc for a page (newest op, else snapshot), or null if blank. */
export const loadPageContent = (notebookId: string, pageId: string) =>
  invoke<string | null>("load_page_content", { notebookId, pageId });

/** Frequent op-log checkpoint (~300ms). */
export const appendPageOp = (notebookId: string, pageId: string, opJson: string) =>
  invoke<void>("append_page_op", { notebookId, pageId, opJson });

/** Durable snapshot (~3s); also refreshes the page-list preview. */
export const savePageSnapshot = (
  notebookId: string,
  pageId: string,
  contentJson: string,
  preview: string,
) => invoke<void>("save_page_snapshot", { notebookId, pageId, contentJson, preview });

// --- Images -----------------------------------------------------------------

/** Absolute path to a notebook's folder, for resolving relative image paths. */
export const notebookPath = (notebookId: string) =>
  invoke<string>("notebook_path", { notebookId });

/** Store an image under attachments/<page>/ and return its relative path. */
export const savePageImage = (
  notebookId: string,
  pageId: string,
  bytes: number[],
  ext: string,
) => invoke<string>("save_page_image", { notebookId, pageId, bytes, ext });

// --- Attachments (spec Section 12) ------------------------------------------

export const listAttachments = (notebookId: string, pageId: string) =>
  invoke<Attachment[]>("list_attachments", { notebookId, pageId });

export const addAttachment = (
  notebookId: string,
  pageId: string,
  filename: string,
  bytes: number[],
  mimeType: string | null,
) => invoke<Attachment>("add_attachment", { notebookId, pageId, filename, bytes, mimeType });

export const removeAttachment = (notebookId: string, attachmentId: string) =>
  invoke<void>("remove_attachment", { notebookId, attachmentId });

/** Open an attachment with the system default app. */
export const openAttachment = (notebookId: string, path: string) =>
  invoke<void>("open_attachment", { notebookId, path });

// --- Search (spec Section 11) -----------------------------------------------

/** Query the master index; `filters.notebookIds` scopes it (empty = all). */
export const search = (query: string, filters: SearchFilters = {}) =>
  invoke<SearchHit[]>("search", { query, filters });

/** Rebuild the master index from every notebook (run once on startup). */
export const reindexAll = () => invoke<void>("reindex_all");

// --- Refine infrastructure (spec Sections 8, 9 / Phase 7) -------------------

/** Bundled model manifest: pinned runtime + tier→model defaults + thresholds. */
export const refineGetManifest = () => invoke<Manifest>("refine_get_manifest");

/** Detect RAM + GPUs and recommend a model tier. */
export const refineDetectHardware = () =>
  invoke<DetectedHardware>("refine_detect_hardware");

/** Whether the pinned Ollama runtime is installed. */
export const refineRuntimeStatus = () =>
  invoke<RuntimeStatus>("refine_runtime_status");

/** Download + verify + extract the runtime; emits `refine://runtime-progress`. */
export const refineInstallRuntime = () =>
  invoke<RuntimeStatus>("refine_install_runtime");

/** Cancel an in-progress runtime download. */
export const refineCancelInstall = () => invoke<void>("refine_cancel_install");

/** Pull a model; emits `refine://model-progress`. */
export const refinePullModel = (model: string) =>
  invoke<void>("refine_pull_model", { model });

/** List models already pulled into the local store. */
export const refineListModels = () =>
  invoke<InstalledModel[]>("refine_list_models");

/** Delete a pulled model and reclaim its disk. */
export const refineDeleteModel = (model: string) =>
  invoke<void>("refine_delete_model", { model });

/** Persist the Refine on/off setting and start/stop Ollama accordingly. */
export const refineEnable = (enabled: boolean) =>
  invoke<ProcessStatus>("refine_enable", { enabled });

/** Snapshot of Ollama's recent stderr (debug panel backfill). */
export const refineOllamaLog = () => invoke<string[]>("refine_ollama_log");

/** Debug panel: one /api/generate call with full parameter control. */
export const refineDebugGenerate = (req: DebugGenerateRequest) =>
  invoke<DebugGenerateResult>("refine_debug_generate", { req });

/** Refine selected text with a template (Phase 8): returns the transformed text
 * for the renderer to diff and render inline. */
export const refineGenerate = (req: RefineRequest) =>
  invoke<RefineResult>("refine_generate", { req });

/** Release Ollama to free memory without disabling Refine (keep-warm idle
 * release); the next Refine re-spawns it. */
export const refineRelease = () => invoke<ProcessStatus>("refine_release");

/** Abort the in-flight Refine generation (Cancel / dismiss); frees the CPU. */
export const refineCancel = () => invoke<void>("refine_cancel");
