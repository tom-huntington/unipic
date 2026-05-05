# Unicode Picker

Static Unicode picker with an offline-generated binary dataset and a browser client that searches a compact trie.

## Build the dataset

```powershell
zig build run
```

That reads the files in `UCD/` and writes:

- `dist/data/meta.json`
- `dist/data/trie.bin`
- `dist/data/trie.bin.gz`
- `dist/data/entries.bin`
- `dist/data/entries.bin.gz`
- `dist/data/strings.bin`
- `dist/data/strings.bin.gz`

## Serve the app

Serve `dist/` with any static file server.

The browser fetches the binary files with `arrayBuffer()`, reads them through typed arrays / `DataView`, and only decodes strings for visible results.
On hosts like GitHub Pages, it prefers the prebuilt `.gz` assets and inflates them in the browser because custom `Content-Encoding` headers are not configurable there.

## Deploy to GitHub Pages

The workflow in `.github/workflows/static.yml` publishes the checked-in `dist/` directory as-is.
It does not build the site in CI, so regenerate `dist/` locally before pushing changes you want deployed.

The current generator indexes:

- Unicode names from `UnicodeData.txt`
- Formal aliases from `NameAliases.txt`
- `U+XXXX` codepoint queries

It emits a packed trie with:

- 14-byte node records
- 5-byte edge records
- 3-byte payload values
- a text sidecar for selected high-frequency word payload ranges

That keeps the generated trie materially smaller than a naive JSON object tree while still supporting prefix lookup directly in the browser.
