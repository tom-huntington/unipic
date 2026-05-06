const decoder = new TextDecoder();
const template = document.querySelector("#result-template");
const queryInput = document.querySelector("#query");
const resultsList = document.querySelector("#results");
const status = document.querySelector("#status");
const clearButton = document.querySelector("#clear");
const EXCLUDED_PREFIX_TERMS = [];
const FALLBACK_RESULT_LIMIT = 32;
const supportsDecompressionStream = typeof DecompressionStream === "function";
const embeddedData = globalThis.UNICODE_EMBEDDED_DATA ?? null;

const state = {
  meta: null,
  trieBuffer: null,
  trieRanges: new Map(),
  entriesBuffer: null,
  stringsBuffer: null,
  activeIndex: -1,
  results: [],
};

void init();

async function init() {
  try {
    const meta = await loadMeta();
    const [trieBuffer, entriesBuffer, stringsBuffer] = await Promise.all([
      fetchDataBuffer(meta.trie),
      fetchDataBuffer(meta.entries),
      fetchDataBuffer(meta.strings),
    ]);
    const trieRanges = await fetchTrieRanges(meta.trieRanges);

    state.meta = meta;
    state.trieBuffer = trieBuffer;
    state.trieRanges = trieRanges;
    state.entriesBuffer = entriesBuffer;
    state.stringsBuffer = stringsBuffer;

    status.textContent = `Loaded ${meta.entries.count.toLocaleString()} entries.`;
    queryInput.disabled = false;
    clearButton.disabled = false;
    queryInput.focus();
  } catch (error) {
    console.error(error);
    status.textContent = "Failed to load the Unicode dataset.";
  }
}

async function loadMeta() {
  if (embeddedData?.meta) {
    return embeddedData.meta;
  }
  return fetchJson("./data/meta.json");
}

queryInput.addEventListener("input", () => {
  const query = queryInput.value;
  renderResults(search(query));
});

queryInput.addEventListener("keydown", (event) => {
  if (!state.results.length) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveIndex((state.activeIndex + 1) % state.results.length);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveIndex((state.activeIndex - 1 + state.results.length) % state.results.length);
  } else if (event.key === "Enter") {
    if (state.activeIndex >= 0) {
      event.preventDefault();
      copyEntry(state.results[state.activeIndex]);
    }
  }
});

clearButton.addEventListener("click", () => {
  queryInput.value = "";
  renderResults([]);
  queryInput.focus();
});

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }
  return response.arrayBuffer();
}

async function fetchDataBuffer(spec) {
  if (!spec) {
    throw new Error("Missing data spec");
  }

  if (spec.compression) {
    const embeddedCompressed = readEmbeddedBinary(spec.file);
    if (embeddedCompressed) {
      if (supportsDecompressionStream) {
        return decompressBuffer(embeddedCompressed, spec.compression);
      }
      if (!spec.fallbackFile) {
        throw new Error(`Embedded compressed data requires DecompressionStream: ${spec.file}`);
      }
    }
  } else {
    const embeddedPlain = readEmbeddedBinary(spec.file);
    if (embeddedPlain) {
      return embeddedPlain;
    }
  }

  if (spec.compression && supportsDecompressionStream) {
    try {
      return await fetchCompressedBuffer(`./data/${spec.file}`, spec.compression);
    } catch (error) {
      if (!spec.fallbackFile) {
        throw error;
      }
      console.warn(`Falling back to ${spec.fallbackFile} after compressed load failed.`, error);
    }
  }

  const fallbackFile = spec.fallbackFile ?? spec.file;
  return fetchBuffer(`./data/${fallbackFile}`);
}

async function fetchTrieRanges(spec) {
  if (!spec || !spec.file) {
    return new Map();
  }

  const embeddedText = readEmbeddedText(spec.file);
  if (embeddedText != null) {
    return parseTrieRanges(embeddedText);
  }

  const response = await fetch(`./data/${spec.file}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${spec.file}`);
  }

  const text = await response.text();
  return parseTrieRanges(text);
}

function parseTrieRanges(text) {
  const ranges = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const [nodeIndexText, startText, lengthText] = line.split(/\s+/);
    const nodeIndex = Number(nodeIndexText);
    const start = Number(startText);
    const length = Number(lengthText);
    if (!Number.isSafeInteger(nodeIndex) || !Number.isSafeInteger(start) || !Number.isSafeInteger(length)) {
      throw new Error(`Invalid trie range: ${line}`);
    }

    const nodeRanges = ranges.get(nodeIndex) ?? [];
    nodeRanges.push([start, length]);
    ranges.set(nodeIndex, nodeRanges);
  }

  return ranges;
}

function readEmbeddedBinary(fileName) {
  const b64 = embeddedData?.files?.[fileName];
  if (!b64) {
    return null;
  }
  return decodeBase64ToArrayBuffer(b64);
}

function readEmbeddedText(fileName) {
  const b64 = embeddedData?.files?.[fileName];
  if (!b64) {
    return null;
  }
  const bytes = new Uint8Array(decodeBase64ToArrayBuffer(b64));
  return decoder.decode(bytes);
}

function decodeBase64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function fetchCompressedBuffer(url, compression) {
  const compressed = await fetchBuffer(url);
  return decompressBuffer(compressed, compression);
}

async function decompressBuffer(buffer, compression) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream(compression));
  return new Response(stream).arrayBuffer();
}

function search(rawQuery) {
  if (!state.meta) {
    return [];
  }

  const resultLimit = getResultLimit();
  const terms = tokenizeQuery(rawQuery);
  const excludedPrefixTerms = terms.filter(matchesExcludedPrefix);
  const searchableTerms = terms.filter((term) => !matchesExcludedPrefix(term));
  if (!terms.length) {
    status.textContent = `Loaded ${state.meta.entries.count.toLocaleString()} entries.`;
    return [];
  }

  const results = intersectQueryTerms(searchableTerms)
    .slice(0, resultLimit)
    .map(readEntry);
  if (results.length < resultLimit && rawQuery.trim()) {
    const codepointMatch = lookupExactCharacter(rawQuery.trim());
    if (codepointMatch && !results.some((entry) => entry.index === codepointMatch.index)) {
      results.push(codepointMatch);
    }
  }

  const limitedResults = results.slice(0, resultLimit);
  status.textContent = formatSearchStatus(limitedResults.length, excludedPrefixTerms);

  return limitedResults;
}

function normalize(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+\s/_.,:;()[\]{}'-]+/g, " ")
    .replace(/[-_/\\.,:;()[\]{}']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeQuery(rawQuery) {
  const normalized = normalize(rawQuery);
  if (!normalized) {
    return [];
  }

  return [...new Set(normalized.split(" ").filter(Boolean))];
}

function intersectQueryTerms(terms) {
  if (!terms.length) {
    return [];
  }

  const resultLimit = getResultLimit();
  if (terms.length === 1) {
    return lookupTriePrefix(terms[0], null, resultLimit);
  }

  let allowedSet = null;
  for (let i = 0; i < terms.length - 1; i += 1) {
    const exactMatches = lookupTrieExact(terms[i]);
    if (!exactMatches.length) {
      return [];
    }

    allowedSet = allowedSet
      ? intersectSets(allowedSet, exactMatches)
      : new Set(exactMatches);

    if (!allowedSet.size) {
      return [];
    }
  }

  return lookupTriePrefix(terms[terms.length - 1], allowedSet, resultLimit);
}

function lookupTriePrefix(query, allowedSet = null, limit = getResultLimit()) {
  const trieView = new DataView(state.trieBuffer);
  const meta = state.meta.trie;
  const nodeIndex = findNodeIndex(trieView, meta, query);
  if (nodeIndex === -1) {
    return [];
  }

  const effectiveLimit = Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER;
  return collectNodeMatches(trieView, meta, nodeIndex, effectiveLimit, allowedSet);
}

function lookupTrieExact(query) {
  const trieView = new DataView(state.trieBuffer);
  const meta = state.meta.trie;
  const nodeIndex = findNodeIndex(trieView, meta, query);
  if (nodeIndex === -1) {
    return [];
  }

  return getNodePayload(trieView, meta, nodeIndex);
}

function intersectSets(existing, values) {
  const next = new Set();
  for (const value of values) {
    if (existing.has(value)) {
      next.add(value);
    }
  }
  return next;
}

function findNodeIndex(view, meta, query) {
  let nodeIndex = 0;

  for (let i = 0; i < query.length; i += 1) {
    const code = query.charCodeAt(i);
    const found = findEdge(view, meta, nodeIndex, code);
    if (found === -1) {
      return -1;
    }
    nodeIndex = found;
  }

  return nodeIndex;
}

function findEdge(view, meta, nodeIndex, code) {
  const nodeOffset = meta.headerSize + nodeIndex * meta.nodeSize;
  const edgeStart = view.getUint32(nodeOffset, true);
  const edgeCount = view.getUint16(nodeOffset + 4, true);

  let left = 0;
  let right = edgeCount - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const edgeOffset = meta.headerSize + meta.nodeCount * meta.nodeSize + (edgeStart + mid) * meta.edgeSize;
    const edgeCode = view.getUint8(edgeOffset);

    if (edgeCode === code) {
      return view.getUint32(edgeOffset + 1, true);
    }

    if (edgeCode < code) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return -1;
}

function getNodePayload(view, meta, nodeIndex) {
  const nodeOffset = meta.headerSize + nodeIndex * meta.nodeSize;
  const payloadStart = view.getUint32(nodeOffset + 6, true);
  const payloadCount = view.getUint32(nodeOffset + 10, true);
  const payloadBase =
    meta.headerSize + meta.nodeCount * meta.nodeSize + meta.edgeCount * meta.edgeSize;

  const results = [];
  for (let i = 0; i < payloadCount; i += 1) {
    const value = readUint24(view, payloadBase + (payloadStart + i) * meta.payloadIndexSize);
    results.push(value);
  }

  const ranges = state.trieRanges.get(nodeIndex);
  if (ranges) {
    for (const [start, length] of ranges) {
      for (let offset = 0; offset < length; offset += 1) {
        results.push(start + offset);
      }
    }
    results.sort((a, b) => a - b);
  }

  return results;
}

function collectNodeMatches(view, meta, nodeIndex, limit, allowedSet = null) {
  const results = [];
  const seen = new Set();
  const stack = [{ nodeIndex, expanded: false }];

  while (stack.length && results.length < limit) {
    const current = stack.pop();
    if (current.expanded) {
      const payload = getNodePayload(view, meta, current.nodeIndex);
      for (const index of payload) {
        if ((allowedSet && !allowedSet.has(index)) || seen.has(index)) {
          continue;
        }
        seen.add(index);
        results.push(index);
        if (results.length >= limit) {
          return results;
        }
      }
      continue;
    }

    if (results.length >= limit) {
      break;
    }

    stack.push({ nodeIndex: current.nodeIndex, expanded: true });
    const children = getNodeChildren(view, meta, current.nodeIndex);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      if (results.length + stack.length >= limit) {
        break;
      }
      stack.push({ nodeIndex: children[i], expanded: false });
    }
  }

  return results;
}

function getNodeChildren(view, meta, nodeIndex) {
  const nodeOffset = meta.headerSize + nodeIndex * meta.nodeSize;
  const edgeStart = view.getUint32(nodeOffset, true);
  const edgeCount = view.getUint16(nodeOffset + 4, true);
  const edgeBase = meta.headerSize + meta.nodeCount * meta.nodeSize;

  const children = [];
  for (let i = 0; i < edgeCount; i += 1) {
    const edgeOffset = edgeBase + (edgeStart + i) * meta.edgeSize;
    children.push(view.getUint32(edgeOffset + 1, true));
  }
  return children;
}

function readUint24(view, offset) {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}

function readEntry(index) {
  const meta = state.meta.entries;
  const view = new DataView(state.entriesBuffer);
  const base = meta.headerSize + index * meta.recordSize;
  const codepoint = view.getUint32(base, true);
  const name = readString(view.getUint32(base + 4, true), view.getUint32(base + 8, true));
  const aliases = readString(view.getUint32(base + 12, true), view.getUint32(base + 16, true));
  const block = readString(view.getUint32(base + 20, true), view.getUint32(base + 24, true));

  return {
    index,
    codepoint,
    char: String.fromCodePoint(codepoint),
    name,
    aliases,
    block,
  };
}

function readString(offset, length) {
  if (!length) {
    return "";
  }
  return decoder.decode(state.stringsBuffer.slice(offset, offset + length));
}

function lookupExactCharacter(query) {
  const chars = Array.from(query);
  if (chars.length !== 1) {
    return null;
  }

  const codepoint = chars[0].codePointAt(0);
  const view = new DataView(state.entriesBuffer);
  const meta = state.meta.entries;

  let low = 0;
  let high = state.meta.entries.count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entryCodepoint = view.getUint32(meta.headerSize + mid * meta.recordSize, true);
    if (entryCodepoint === codepoint) {
      return readEntry(mid);
    }
    if (entryCodepoint < codepoint) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return null;
}

function matchesExcludedPrefix(term) {
  return EXCLUDED_PREFIX_TERMS.some(
    (excluded) => excluded.startsWith(term) || term.startsWith(excluded),
  );
}

function formatSearchStatus(resultCount, excludedPrefixTerms) {
  const resultText = resultCount
    ? `${resultCount} result${resultCount === 1 ? "" : "s"}`
    : "No matches.";
  if (!excludedPrefixTerms.length) {
    return resultText;
  }

  const terms = excludedPrefixTerms.map((term) => `"${term}"`).join(", ");
  return `${resultText} Prefixes for CJK and UNIFIED are not indexed (${terms}).`;
}

function renderResults(results) {
  const limitedResults = results.slice(0, getResultLimit());
  state.results = limitedResults;
  state.activeIndex = limitedResults.length ? 0 : -1;
  resultsList.textContent = "";

  for (const [index, entry] of limitedResults.entries()) {
    const fragment = template.content.cloneNode(true);
    const button = fragment.querySelector(".result-button");
    const glyph = fragment.querySelector(".glyph");
    const title = fragment.querySelector(".title");
    const detail = fragment.querySelector(".detail");

    glyph.textContent = visibleGlyph(entry);
    title.textContent = `${entry.name} (${formatCodepoint(entry.codepoint)})`;
    detail.textContent = [entry.aliases, entry.block].filter(Boolean).join(" · ");
    button.addEventListener("click", () => copyEntry(entry));
    button.addEventListener("mouseenter", () => setActiveIndex(index));
    if (index === state.activeIndex) {
      button.classList.add("is-active");
    }

    resultsList.append(fragment);
  }
}

function getResultLimit() {
  return state.meta?.resultLimit ?? FALLBACK_RESULT_LIMIT;
}

function setActiveIndex(index) {
  state.activeIndex = index;
  const buttons = resultsList.querySelectorAll(".result-button");
  buttons.forEach((button, buttonIndex) => {
    button.classList.toggle("is-active", buttonIndex === index);
  });
}

async function copyEntry(entry) {
  try {
    await navigator.clipboard.writeText(entry.char);
    status.textContent = `Copied ${entry.name}.`;
  } catch (error) {
    console.error(error);
    status.textContent = "Clipboard write failed.";
  }
}

function visibleGlyph(entry) {
  const invisibleCategories = ["ZERO WIDTH", "COMBINING", "CONTROL"];
  if (invisibleCategories.some((prefix) => entry.name.startsWith(prefix))) {
    return formatCodepoint(entry.codepoint);
  }
  return entry.char;
}

function formatCodepoint(codepoint) {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`;
}
