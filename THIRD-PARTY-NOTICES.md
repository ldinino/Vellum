# Third-Party Notices

Vellum is licensed under the MIT License (see [LICENSE](LICENSE)). It includes
and builds upon third-party assets and software that carry their own licenses,
reproduced or referenced below. This file is provided to satisfy the attribution
requirements of those licenses.

## Bundled assets

### Fugue Icons 3.5.6

Toolbar, menu, and navigation icons.

- Copyright © 2013 Yusuke Kamiyamane — <https://p.yusukekamiyamane.com/>
- Licensed under the Creative Commons Attribution 3.0 License —
  <https://creativecommons.org/licenses/by/3.0/>

Vellum ships only icons from the base set, which are licensed under CC&nbsp;BY&nbsp;3.0.
A small number of icons in the full Fugue distribution carry share-alike or other
licenses (for example: geotag, language, open-share, opml, share, xfn); those
icons are **not** included in Vellum.

### 7.css

Window caption-button glyphs and selected glassy fills and highlights, adapted
into Vellum's stylesheet.

- Copyright © Khang Nguyen Duy and 7.css contributors —
  <https://github.com/khang-nd/7.css>
- Licensed under the MIT License —
  <https://github.com/khang-nd/7.css/blob/main/LICENSE>

## Bundled software

### Harper (`harper-core`)

The grammar and spelling engine, embedded directly in the application.

- <https://crates.io/crates/harper-core>
- Licensed under the Apache License, Version 2.0.

## Downloaded at runtime (not bundled)

### Ollama

The local model runtime used by the optional Refine feature. It is downloaded on
first use into a per-user location and is **not** redistributed with Vellum.

- <https://github.com/ollama/ollama>
- Licensed under the MIT License.

## Development-time references (not distributed)

Some visual styling values (colors and gradients) were derived by inspecting
external reference material fetched locally during development. No third-party
code from those references is copied into or distributed with Vellum.

## Fonts

Vellum uses fonts already present on the user's system (such as Segoe UI,
Calibri, Cambria, and Consolas). It does not bundle or redistribute any font
files.

## Other dependencies

Vellum is built with additional open-source libraries — including the Tauri,
React, and Tiptap projects and their dependencies — distributed under permissive
licenses such as MIT and Apache-2.0. Full per-package license texts are available
through their respective npm and Cargo registries.
