// Tiptap extension set for the editor (spec Section 6).
//
// StarterKit v3 already bundles bold, italic, strike, code, headings, lists,
// blockquote, code block, horizontal rule, hard break, history, AND link +
// underline — so those are configured through StarterKit, never re-added
// (double registration throws). FontFamily/FontSize/Color ship in
// extension-text-style and require TextStyle to be present.

import StarterKit from "@tiptap/starter-kit";
import {
  TextStyle,
  Color,
  FontFamily,
  FontSize,
} from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Superscript from "@tiptap/extension-superscript";
import Subscript from "@tiptap/extension-subscript";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import type { Extensions } from "@tiptap/react";
import { ResizableImage } from "./ResizableImage";
import { SearchHighlight } from "./SearchHighlight";
import { Find } from "./find";
import { GrammarError } from "./GrammarError";

export function buildExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: false, // we open via Ctrl/Cmd-click and context menu
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      },
      // codeBlock kept (monospace, no syntax highlighting — spec v1)
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Superscript,
    Subscript,
    ResizableImage,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    SearchHighlight,
    Find,
    GrammarError,
  ];
}
