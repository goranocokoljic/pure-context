# Bundled tree-sitter grammars (`*.wasm`)

PureContext parses source with **`web-tree-sitter` (WASM) on every supported Node
version** — there is no native parsing path (see `src/core/parse-dispatcher.ts`).
All language handlers load a precompiled `.wasm` grammar from this directory via
`grammarPath()`; e.g. `src/handlers/dart.ts` → `tree-sitter-dart.wasm`.

These `.wasm` files are **committed to the repo and shipped in the npm package**
(`grammars/` is in `package.json` `files`). Because of this, the per-language
`tree-sitter-*` npm packages are **not** runtime or build dependencies — they are
only *sources* used to regenerate a `.wasm` when a grammar needs an update.

Keeping them out of `package.json` is deliberate: every `tree-sitter-*` package is
a native addon that triggers `node-gyp` at install time, which requires platform
C/C++ build tools (MSVC on Windows, etc.). Listing them as dependencies made
`npm ci` — in CI and for end users running `npm install purecontext-mcp` — fail on
any machine without a toolchain. The committed `.wasm` files make installation
toolchain-free.

> The one genuinely-native dependency is `better-sqlite3`, which ships prebuilt
> binaries (no `node-gyp`) for Node 18/20/22 and falls back to
> `@sqlite.org/sqlite-wasm` otherwise. That split is intentional and unrelated to
> tree-sitter.

## Grammar → source package

| `.wasm` file                  | npm source package           | version  |
|-------------------------------|------------------------------|----------|
| `tree-sitter-bash.wasm`       | `tree-sitter-bash`           | ^0.23.3  |
| `tree-sitter-c.wasm`          | `tree-sitter-c`              | ^0.23.2  |
| `tree-sitter-cpp.wasm`        | `tree-sitter-cpp`            | ^0.23.4  |
| `tree-sitter-csharp.wasm`     | `tree-sitter-c-sharp`        | ^0.23.1  |
| `tree-sitter-dart.wasm`       | `tree-sitter-dart`           | ^1.0.0   |
| `tree-sitter-elixir.wasm`     | `tree-sitter-elixir`         | ^0.3.5   |
| `tree-sitter-go.wasm`         | `tree-sitter-go`             | ^0.23.4  |
| `tree-sitter-haskell.wasm`    | `tree-sitter-haskell`        | ^0.23.1  |
| `tree-sitter-java.wasm`       | `tree-sitter-java`           | ^0.23.5  |
| `tree-sitter-javascript.wasm` | `tree-sitter-javascript`     | ^0.25.0  |
| `tree-sitter-kotlin.wasm`     | `tree-sitter-kotlin`         | ^0.3.8   |
| `tree-sitter-lua.wasm`        | `tree-sitter-lua`            | ^2.0.0   |
| `tree-sitter-perl.wasm`       | `tree-sitter-perl`           | ^1.0.0   |
| `tree-sitter-php.wasm`        | `tree-sitter-php`            | ^0.23.12 |
| `tree-sitter-python.wasm`     | `tree-sitter-python`         | ^0.23.6  |
| `tree-sitter-r.wasm`          | `@davisvaughan/tree-sitter-r`| ^1.2.0   |
| `tree-sitter-ruby.wasm`       | `tree-sitter-ruby`           | ^0.23.1  |
| `tree-sitter-rust.wasm`       | `tree-sitter-rust`           | ^0.24.0  |
| `tree-sitter-scala.wasm`      | `tree-sitter-scala`          | ^0.24.0  |
| `tree-sitter-swift.wasm`      | `tree-sitter-swift`          | ^0.7.1   |
| `tree-sitter-tsx.wasm`        | `tree-sitter-typescript` (`tsx/` subdir)        | ^0.23.2 |
| `tree-sitter-typescript.wasm` | `tree-sitter-typescript` (`typescript/` subdir) | ^0.23.2 |

Notes:
- `tree-sitter-typescript` is a multi-grammar package: it produces **two** `.wasm`
  files, one from its `typescript/` subdirectory and one from `tsx/`.
- The `tree-sitter.wasm` runtime core is *not* in this table — it ships inside the
  `web-tree-sitter` package and is located at runtime (`parse-dispatcher.ts`).

## Regenerating a `.wasm`

You only need this when bumping a grammar version or adding a language. It needs
[Emscripten](https://emscripten.org/) (`emcc` on `PATH`) or Docker, which the
`tree-sitter` CLI uses to compile the grammar to WASM.

```bash
# 1. Install the tree-sitter CLI and the single grammar you are rebuilding.
#    (Do NOT add these to package.json — install them ad hoc.)
npm i -g tree-sitter-cli@0.23      # match the CLI to the grammar's ABI
npm i tree-sitter-dart@1.0.0       # the grammar source you want to rebuild

# 2. Build the grammar to WASM from its package directory.
#    tree-sitter CLI >= 0.23:
tree-sitter build --wasm node_modules/tree-sitter-dart
#    (older CLI used the now-deprecated `tree-sitter build-wasm` form)

# 3. Move the produced tree-sitter-dart.wasm into this directory, overwriting
#    the committed copy, then commit it.
mv tree-sitter-dart.wasm grammars/

# 4. For multi-grammar packages, point the CLI at each subdirectory:
tree-sitter build --wasm node_modules/tree-sitter-typescript/typescript
tree-sitter build --wasm node_modules/tree-sitter-typescript/tsx

# 5. Sanity-check the new grammar loads and parses:
npm run build && npm test
```

After regenerating, uninstall the ad-hoc grammar package so it doesn't leak back
into `package.json` / the lockfile.
