// markdown-it-task-lists ships no type declarations; declare the bits we use.
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  interface TaskListsOptions {
    /** Leave the rendered checkboxes interactive (default false → disabled). */
    enabled?: boolean;
    /** Wrap the item body in a <label> (default false). */
    label?: boolean;
    /** Put the <label> after the checkbox (default false). */
    labelAfter?: boolean;
  }
  const taskLists: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default taskLists;
}
