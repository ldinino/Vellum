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
