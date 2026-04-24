const decoder = new TextDecoder();
const template = document.querySelector("#result-template");
const queryInput = document.querySelector("#query");
const resultsList = document.querySelector("#results");
const status = document.querySelector("#status");
const clearButton = document.querySelector("#clear");

const state = {
  meta: null,
  trieBuffer: null,
  entriesBuffer: null,
  stringsBuffer: null,
  activeIndex: -1,
  results: [],
};

void init();

async function init() {
  try {
    const meta = await fetchJson("./data/meta.json");
    const [trieBuffer, entriesBuffer, stringsBuffer] = await Promise.all([
      fetchBuffer(`./data/${meta.trie.file}`),
      fetchBuffer(`./data/${meta.entries.file}`),
      fetchBuffer(`./data/${meta.strings.file}`),
    ]);

    state.meta = meta;
    state.trieBuffer = trieBuffer;
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

function search(rawQuery) {
  if (!state.meta) {
    return [];
  }

  const normalized = normalize(rawQuery);
  if (!normalized) {
    status.textContent = `Loaded ${state.meta.entries.count.toLocaleString()} entries.`;
    return [];
  }

  const results = lookupTrie(normalized);
  if (!results.length && rawQuery.trim()) {
    const codepointMatch = lookupExactCharacter(rawQuery.trim());
    if (codepointMatch) {
      results.push(codepointMatch);
    }
  }

  status.textContent = results.length
    ? `${results.length} result${results.length === 1 ? "" : "s"}`
    : "No matches.";

  return results;
}

function normalize(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+\s/_.,:;()[\]{}'-]+/g, " ")
    .replace(/[-_/\\.,:;()[\]{}']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lookupTrie(query) {
  const trieView = new DataView(state.trieBuffer);
  const meta = state.meta.trie;
  let nodeIndex = 0;

  for (let i = 0; i < query.length; i += 1) {
    const code = query.charCodeAt(i);
    const found = findEdge(trieView, meta, nodeIndex, code);
    if (found === -1) {
      return [];
    }
    nodeIndex = found;
  }

  const payload = getNodePayload(trieView, meta, nodeIndex);
  return payload.map(readEntry);
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
  const payloadCount = view.getUint16(nodeOffset + 10, true);
  const payloadBase =
    meta.headerSize + meta.nodeCount * meta.nodeSize + meta.edgeCount * meta.edgeSize;

  const results = [];
  for (let i = 0; i < payloadCount; i += 1) {
    results.push(readUint24(view, payloadBase + (payloadStart + i) * meta.payloadIndexSize));
  }
  return results;
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

function renderResults(results) {
  state.results = results;
  state.activeIndex = results.length ? 0 : -1;
  resultsList.textContent = "";

  for (const [index, entry] of results.entries()) {
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
