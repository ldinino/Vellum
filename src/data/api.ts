// Thin wrappers over the Rust commands. Argument keys are camelCase; Tauri v2
// maps them to the snake_case Rust parameters automatically.

import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  AppPaths,
  Attachment,
  DebugGenerateRequest,
  DebugGenerateResult,
  DetectedHardware,
  ExportCopy,
  ExportPageEntry,
  GrammarSpan,
  ImportEntry,
  InstalledModel,
  LeaseStanding,
  LogEntry,
  Manifest,
  Notebook,
  Page,
  PageSortDir,
  PageSortMode,
  ProcessStatus,
  RecycleItem,
  RefineRequest,
  RefineResult,
  RuntimeStatus,
  SatchelInfo,
  SatchelProblem,
  Section,
  SearchFilters,
  SearchHit,
  SyncProvider,
  SyncReport,
  SyncStatus,
  VersionInfo,
} from "./types";

// --- App config (app.json) --------------------------------------------------

export const getAppConfig = () => invoke<AppConfig>("get_app_config");

export const saveAppConfig = (config: AppConfig) =>
  invoke<void>("save_app_config", { config });

// --- Paths / versions / export (Phase 10) -----------------------------------

/** Filesystem locations (Settings → General). */
export const getPaths = () => invoke<AppPaths>("get_paths");

/** Turn the desktop acrylic blur behind the chrome on (Aero) or off (98). */
export const setWindowAcrylic = (enabled: boolean) =>
  invoke<void>("set_window_acrylic", { enabled });

export const showMainWindow = () => invoke<void>("show_main_window");

/** App / Harper / Ollama versions (Settings → About). */
export const getVersionInfo = () => invoke<VersionInfo>("get_version_info");

// --- Diagnostics / app log (Phase 11) ---------------------------------------

/** Recent app-log entries (oldest → newest) for Settings → About. */
export const getAppLog = () => invoke<LogEntry[]>("get_app_log");

/** Clear the in-memory log view (the on-disk file is kept for export). */
export const clearAppLog = () => invoke<void>("clear_app_log");

/** Write the full on-disk diagnostic log to a chosen path. */
export const exportAppLog = (destPath: string) =>
  invoke<void>("export_app_log", { destPath });

/** Record a renderer-side event in the app log (best-effort). */
export const logFrontendEvent = (
  level: "error" | "warn" | "info",
  area: string,
  message: string,
) => invoke<void>("log_frontend_event", { level, area, message });

/** Reveal the active Satchel's folder in the system file manager. */
export const revealDataDir = () => invoke<void>("reveal_data_dir");

// --- Satchels ---------------------------------------------------------------

/** Satchels known to this machine, in list order. */
export const listSatchels = () => invoke<SatchelInfo[]>("list_satchels");

/** Why the active Satchel couldn't be opened at startup, if anything. */
export const getSatchelProblem = () => invoke<SatchelProblem | null>("get_satchel_problem");

/** Create `<parent>\<name>` as a new Satchel, optionally seeding it with a copy
 * of the current Satchel's settings. Does not switch to it. */
export const createSatchel = (parent: string, name: string, copySettings: boolean) =>
  invoke<SatchelInfo>("create_satchel", { parent, name, copySettings });

/** Add an existing folder to this machine's list. Without `adopt`, a folder
 * with no `satchel.json` is rejected with `NOT_A_SATCHEL`. */
export const openSatchel = (path: string, adopt = false) =>
  invoke<SatchelInfo>("open_satchel", { path, adopt });

/** Record which Satchel to use — the caller then relaunches. */
export const setActiveSatchel = (id: string) => invoke<void>("set_active_satchel", { id });

/** Remove a Satchel from this machine's list. Deletes nothing on disk. */
export const forgetSatchel = (id: string) => invoke<void>("forget_satchel", { id });

export const renameSatchel = (id: string, name: string) =>
  invoke<void>("rename_satchel", { id, name });

// --- Sync -------------------------------------------------------------------

/** The curated provider tiles for the setup wizard. */
export const syncProviders = () => invoke<SyncProvider[]>("sync_providers");

/** Sync state for the active Satchel (Settings → Sync). */
export const syncStatus = () => invoke<SyncStatus>("sync_status");

/** Save a remote after the backend proves it works. `values` is keyed by the
 * provider's field keys. Rejects rather than saving a remote that can't be
 * written to. */
export const syncConfigure = (
  providerId: string,
  values: Record<string, string>,
  path: string,
) => invoke<void>("sync_configure", { providerId, values, path });

/** The remote as one pasteable string, encrypted under `passphrase`. */
export const syncConnectionCode = (passphrase: string) =>
  invoke<string>("sync_connection_code", { passphrase });

/** Write the connection code to a chosen path (the backend owns file output). */
export const syncWriteConnectionCode = (destPath: string, passphrase: string) =>
  invoke<void>("sync_write_connection_code", { destPath, passphrase });

/** Adopt a remote from another device's connection code. */
export const syncApplyConnectionCode = (code: string, passphrase: string) =>
  invoke<void>("sync_apply_connection_code", { code, passphrase });

/** Forget the remote on this machine. Deletes nothing, locally or remotely. */
export const syncStop = () => invoke<void>("sync_stop");

/** Push now. `takeOver` answers another device holding the lease. */
export const syncNow = (takeOver = false) => invoke<SyncReport>("sync_now", { takeOver });

/** Take the lease and pull, when a synced Satchel is opened. */
export const syncBeginSession = () => invoke<SyncReport | null>("sync_begin_session");

/** Refresh our lease. A named `takenOverBy` means another device took over. */
export const syncRefreshLease = () => invoke<LeaseStanding>("sync_refresh_lease");

/** Keep this session's unsynced work as a conflict Satchel; returns its path. */
export const syncPreserveLocalCopy = () => invoke<string>("sync_preserve_local_copy");

/** Take the Satchel back after standing down. Always the user's own choice. */
export const syncTakeBack = () => invoke<void>("sync_take_back");

/** Write a page's Markdown to `mdPath` and copy its images/attachments into a
 * sibling `<filesDirName>/` folder next to it (spec Section 14). */
export const exportPage = (
  notebookId: string,
  mdPath: string,
  markdown: string,
  filesDirName: string,
  copies: ExportCopy[],
) => invoke<void>("export_page", { notebookId, mdPath, markdown, filesDirName, copies });

/** Write a batch of pages under `destDir` (each at `<destDir>/<relPath>`) and copy
 * their files into one shared `<destDir>/<attachmentsDirName>/` folder
 * (execution-plan #6). Returns the number of pages written. */
export const exportBatch = (
  notebookId: string,
  destDir: string,
  attachmentsDirName: string,
  pages: ExportPageEntry[],
) => invoke<number>("export_batch", { notebookId, destDir, attachmentsDirName, pages });

/** Open a folder (or a file's location) in the system file manager. */
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });

// --- Import (execution-plan #4) ---------------------------------------------

/** Recursively scan a picked folder for importable documents (md/html/txt/docx),
 * skipping dot-directories. Entries are sorted by relative path. */
export const importScanFolder = (root: string) =>
  invoke<ImportEntry[]>("import_scan_folder", { root });

/** Read an importable document's raw bytes (size-capped). Returned as an
 * `ArrayBuffer` (via `tauri::ipc::Response`) so binary files like `.docx`
 * transfer intact rather than through a lossy/slow JSON number array. */
export const importReadFile = (path: string) =>
  invoke<ArrayBuffer>("import_read_file", { path });

/** Resolve an image reference from an imported document and copy it into the
 * page's attachments folder, returning the new notebook-relative path (or null
 * when it's a URL/data URI, missing, or resolves outside the import root). A
 * leading `/` in `srcRef` resolves against `rootDir`, else against `baseDir`. */
export const importCopyExternalImage = (
  notebookId: string,
  pageId: string,
  baseDir: string,
  rootDir: string,
  srcRef: string,
) =>
  invoke<string | null>("import_copy_external_image", {
    notebookId,
    pageId,
    baseDir,
    rootDir,
    srcRef,
  });

// --- Grammar (Harper, spec Section 10) --------------------------------------

/** Lint plain text; offsets are UTF-16 code units into `text`. */
export const grammarCheck = (text: string) =>
  invoke<GrammarSpan[]>("grammar_check", { text });

/** Replace Harper's custom dictionary (spec Section 10). The word list is
 * persisted in app.json by the caller; this syncs the in-memory engine so
 * underlines refresh immediately after an add/remove. */
export const setDictionaryWords = (words: string[]) =>
  invoke<void>("set_dictionary_words", { words });

// --- Links ------------------------------------------------------------------

/** Best-effort fetch of a URL's page `<title>` so a pasted bare link can show a
 * readable label. Resolves to `null` when no usable title is found. */
export const fetchLinkTitle = (url: string) =>
  invoke<string | null>("fetch_link_title", { url });

// --- Notebooks (notebooks.json registry) -----------------------------------

export const listNotebooks = () => invoke<Notebook[]>("list_notebooks");

export const createNotebook = (name: string) =>
  invoke<Notebook>("create_notebook", { name });

export const renameNotebook = (notebookId: string, name: string) =>
  invoke<Notebook>("rename_notebook", { notebookId, name });

export const setNotebookColor = (notebookId: string, color: string | null) =>
  invoke<void>("set_notebook_color", { notebookId, color });

/** Set a notebook's per-category proofreading prefs (execution-plan #5):
 * true = on, false = off, null = inherit. */
export const setNotebookProofing = (
  notebookId: string,
  grammarPref: boolean | null,
  spellPref: boolean | null,
) => invoke<void>("set_notebook_proofing", { notebookId, grammarPref, spellPref });

/** Move a notebook to the Recycle Bin (recoverable; spec Section 5.1). */
export const softDeleteNotebook = (notebookId: string) =>
  invoke<void>("soft_delete_notebook", { notebookId });

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

/** Move a section (and its pages) to the Recycle Bin (spec Section 5.1). */
export const softDeleteSection = (notebookId: string, sectionId: string) =>
  invoke<void>("soft_delete_section", { notebookId, sectionId });

export const reorderSections = (notebookId: string, orderedIds: string[]) =>
  invoke<void>("reorder_sections", { notebookId, orderedIds });

/** Persist a section's page sort preference (spec Section 5 / Phase 9). */
export const setSectionSort = (
  notebookId: string,
  sectionId: string,
  mode: PageSortMode,
  dir: PageSortDir,
) => invoke<void>("set_section_sort", { notebookId, sectionId, mode, dir });

/** Set a section's per-category proofreading prefs (execution-plan #5):
 * true = on, false = off, null = inherit. */
export const setSectionProofing = (
  notebookId: string,
  sectionId: string,
  grammarPref: boolean | null,
  spellPref: boolean | null,
) => invoke<void>("set_section_proofing", { notebookId, sectionId, grammarPref, spellPref });

// --- Pages (per-notebook DB) ------------------------------------------------

export const listPages = (notebookId: string, sectionId: string) =>
  invoke<Page[]>("list_pages", { notebookId, sectionId });

export const createPage = (notebookId: string, sectionId: string, title: string) =>
  invoke<Page>("create_page", { notebookId, sectionId, title });

export const setPageTitle = (notebookId: string, pageId: string, title: string) =>
  invoke<void>("set_page_title", { notebookId, pageId, title });

/** Set a page's per-category proofreading prefs (execution-plan #5):
 * true = on, false = off, null = inherit. */
export const setPageProofing = (
  notebookId: string,
  pageId: string,
  grammarPref: boolean | null,
  spellPref: boolean | null,
) => invoke<void>("set_page_proofing", { notebookId, pageId, grammarPref, spellPref });

/** Move a page to the Recycle Bin (spec Section 5.1). */
export const softDeletePage = (notebookId: string, pageId: string) =>
  invoke<void>("soft_delete_page", { notebookId, pageId });

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

/** Delete inline-image files under attachments/<page>/ that the live document no
 * longer references (keepSrcs = image srcs still in the doc). Fire-and-forget on
 * navigate-away / app close; returns the number of files removed. */
export const cleanupPageImages = (notebookId: string, pageId: string, keepSrcs: string[]) =>
  invoke<number>("cleanup_page_images", { notebookId, pageId, keepSrcs });

/** Copy an inline image pasted from another page into this page's own folder so
 * each page owns its files; returns the new relative path. */
export const copyImageToPage = (notebookId: string, srcRel: string, pageId: string) =>
  invoke<string>("copy_image_to_page", { notebookId, srcRel, pageId });

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

/** Remove an attachment from its page into the Recycle Bin (recoverable; the
 * file stays on disk until purged — spec Section 5.1). */
export const softDeleteAttachment = (notebookId: string, attachmentId: string) =>
  invoke<void>("soft_delete_attachment", { notebookId, attachmentId });

/** Open an attachment with the system default app. */
export const openAttachment = (notebookId: string, path: string) =>
  invoke<void>("open_attachment", { notebookId, path });

// --- Recycle Bin (spec Section 5.1) -----------------------------------------

/** Every soft-deleted item across all notebooks, newest first. */
export const listRecycleBin = () => invoke<RecycleItem[]>("list_recycle_bin");

/** Count of items in the Recycle Bin, for the nav footer's empty/full icon. */
export const countRecycleBin = () => invoke<number>("count_recycle_bin");

/** Restore one item to where it came from. */
export const restoreItem = (kind: string, notebookId: string, id: string) =>
  invoke<void>("restore_item", { kind, notebookId, id });

/** Permanently delete one item (and, for containers, everything inside). */
export const purgeItem = (kind: string, notebookId: string, id: string) =>
  invoke<void>("purge_item", { kind, notebookId, id });

/** Permanently delete everything in the Recycle Bin. */
export const emptyRecycleBin = () => invoke<void>("empty_recycle_bin");

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
