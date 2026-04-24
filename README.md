# Unicode Picker

Static Unicode picker with an offline-generated binary dataset and a browser client that searches a compact trie.

## Build the dataset

```powershell
zig build run
```

That reads the files in `UCD/` and writes:

- `dist/data/meta.json`
- `dist/data/trie.bin`
- `dist/data/entries.bin`
- `dist/data/strings.bin`

## Serve the app

Serve `dist/` with any static file server.

The browser fetches the binary files with `arrayBuffer()`, reads them through typed arrays / `DataView`, and only decodes strings for visible results.

The current generator indexes:

- Unicode names from `UnicodeData.txt`
- Formal aliases from `NameAliases.txt`
- `U+XXXX` codepoint queries

It emits a packed trie with:

- 12-byte node records
- 5-byte edge records
- 3-byte payload indices

That keeps the generated trie materially smaller than a naive JSON object tree while still supporting prefix lookup directly in the browser.
