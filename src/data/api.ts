// Thin wrappers over the Rust commands. Argument keys are camelCase; Tauri v2
// maps them to the snake_case Rust parameters automatically.

import { invoke } from "@tauri-apps/api/core";
import type { Notebook, Page, Section } from "./types";

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
