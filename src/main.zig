const std = @import("std");

const result_limit = 64;
const entry_record_size = 28;
const trie_header_size = 16;
const trie_node_size = 12;
const trie_edge_size = 5;
const trie_payload_index_size = 3;
const entries_header_size = 8;

const BlockRange = struct {
    start: u32,
    end: u32,
    name: []const u8,
};

const Entry = struct {
    codepoint: u32,
    name: []const u8,
    block_name: []const u8,
    aliases: std.ArrayList([]const u8),
};

const RangeState = struct {
    start: u32,
    label: []const u8,
    category: []const u8,
};

const TrieEdgeBuilder = struct {
    ch: u8,
    target: u32,
};

const TrieNodeBuilder = struct {
    children: std.ArrayList(TrieEdgeBuilder),
    payload: std.ArrayList(u32),
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const arena_allocator = arena.allocator();

    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();

    _ = args.next();
    const ucd_dir = args.next() orelse "UCD";
    const out_dir = args.next() orelse "dist/data";

    try std.fs.cwd().makePath(out_dir);

    const blocks = try loadBlocks(arena_allocator, ucd_dir);

    var entries: std.ArrayList(Entry) = .{};
    defer {
        for (entries.items) |*entry| {
            entry.aliases.deinit(allocator);
        }
        entries.deinit(allocator);
    }

    var entry_index = std.AutoHashMap(u32, u32).init(allocator);
    defer entry_index.deinit();

    try loadUnicodeData(arena_allocator, allocator, ucd_dir, blocks.items, &entries, &entry_index);
    try loadNameAliases(arena_allocator, allocator, ucd_dir, &entries, &entry_index);

    var trie_nodes: std.ArrayList(TrieNodeBuilder) = .{};
    defer {
        for (trie_nodes.items) |*node| {
            node.children.deinit(allocator);
            node.payload.deinit(allocator);
        }
        trie_nodes.deinit(allocator);
    }

    try trie_nodes.append(allocator, .{
        .children = .{},
        .payload = .{},
    });

    try buildTrie(arena_allocator, allocator, &entries, &trie_nodes);

    try writeEntriesFile(allocator, out_dir, entries.items);
    try writeTrieFile(allocator, out_dir, trie_nodes.items);
    try writeMetaFile(allocator, out_dir, entries.items.len, trie_nodes.items);

    std.debug.print(
        "Generated {d} entries and {d} trie nodes into {s}\n",
        .{ entries.items.len, trie_nodes.items.len, out_dir },
    );
}

fn loadBlocks(allocator: std.mem.Allocator, ucd_dir: []const u8) !std.ArrayList(BlockRange) {
    const path = try std.fs.path.join(allocator, &.{ ucd_dir, "Blocks.txt" });
    defer allocator.free(path);

    const data = try std.fs.cwd().readFileAlloc(allocator, path, 1 << 20);
    var blocks: std.ArrayList(BlockRange) = .{};

    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line_raw| {
        const line = std.mem.trim(u8, line_raw, " \r\t");
        if (line.len == 0 or line[0] == '#') continue;

        const semi = std.mem.indexOfScalar(u8, line, ';') orelse continue;
        const range_text = std.mem.trim(u8, line[0..semi], " ");
        const name = std.mem.trim(u8, line[semi + 1 ..], " ");

        const dots = std.mem.indexOf(u8, range_text, "..") orelse continue;
        const start = try std.fmt.parseInt(u32, range_text[0..dots], 16);
        const end = try std.fmt.parseInt(u32, range_text[dots + 2 ..], 16);

        try blocks.append(allocator, .{
            .start = start,
            .end = end,
            .name = name,
        });
    }

    return blocks;
}

fn loadUnicodeData(
    arena_allocator: std.mem.Allocator,
    allocator: std.mem.Allocator,
    ucd_dir: []const u8,
    blocks: []const BlockRange,
    entries: *std.ArrayList(Entry),
    entry_index: *std.AutoHashMap(u32, u32),
) !void {
    const path = try std.fs.path.join(arena_allocator, &.{ ucd_dir, "UnicodeData.txt" });
    const data = try std.fs.cwd().readFileAlloc(arena_allocator, path, 4 << 20);

    var pending_range: ?RangeState = null;
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line_raw| {
        const line = std.mem.trim(u8, line_raw, "\r");
        if (line.len == 0) continue;

        var fields = std.mem.splitScalar(u8, line, ';');
        const code_text = fields.next() orelse continue;
        const raw_name = fields.next() orelse continue;
        const category = fields.next() orelse continue;
        _ = fields.next();
        _ = fields.next();
        _ = fields.next();
        _ = fields.next();
        _ = fields.next();
        _ = fields.next();
        _ = fields.next();
        const unicode_1_name = fields.next() orelse "";

        const codepoint = try std.fmt.parseInt(u32, code_text, 16);
        if (std.mem.eql(u8, category, "Cs") or std.mem.eql(u8, category, "Co")) {
            continue;
        }

        if (isRangeFirst(raw_name)) {
            pending_range = .{
                .start = codepoint,
                .label = raw_name,
                .category = category,
            };
            continue;
        }

        if (isRangeLast(raw_name)) {
            const range = pending_range orelse continue;
            pending_range = null;
            try expandRange(arena_allocator, allocator, blocks, entries, entry_index, range.start, codepoint, range.label, range.category);
            continue;
        }

        if (raw_name.len > 0 and raw_name[0] == '<') {
            if (std.mem.eql(u8, raw_name, "<control>") and unicode_1_name.len > 0) {
                try addEntry(arena_allocator, allocator, blocks, entries, entry_index, codepoint, unicode_1_name, &.{});
            }
            continue;
        }

        var initial_aliases: std.ArrayList([]const u8) = .{};
        defer initial_aliases.deinit(allocator);
        if (unicode_1_name.len > 0) {
            try initial_aliases.append(allocator, unicode_1_name);
        }

        try addEntry(arena_allocator, allocator, blocks, entries, entry_index, codepoint, raw_name, initial_aliases.items);
    }
}

fn loadNameAliases(
    arena_allocator: std.mem.Allocator,
    allocator: std.mem.Allocator,
    ucd_dir: []const u8,
    entries: *std.ArrayList(Entry),
    entry_index: *std.AutoHashMap(u32, u32),
) !void {
    const path = try std.fs.path.join(arena_allocator, &.{ ucd_dir, "NameAliases.txt" });
    const data = try std.fs.cwd().readFileAlloc(arena_allocator, path, 1 << 20);

    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line_raw| {
        const line = std.mem.trim(u8, line_raw, " \r\t");
        if (line.len == 0 or line[0] == '#') continue;

        var fields = std.mem.splitScalar(u8, line, ';');
        const code_text = fields.next() orelse continue;
        const alias_text = std.mem.trim(u8, fields.next() orelse continue, " ");
        const codepoint = try std.fmt.parseInt(u32, code_text, 16);

        const index = entry_index.get(codepoint) orelse continue;
        const entry = &entries.items[index];
        if (!containsString(entry.aliases.items, alias_text)) {
            try entry.aliases.append(allocator, alias_text);
        }
    }
}

fn addEntry(
    arena_allocator: std.mem.Allocator,
    allocator: std.mem.Allocator,
    blocks: []const BlockRange,
    entries: *std.ArrayList(Entry),
    entry_index: *std.AutoHashMap(u32, u32),
    codepoint: u32,
    name: []const u8,
    initial_aliases: []const []const u8,
) !void {
    const block_name = findBlock(blocks, codepoint);

    var aliases: std.ArrayList([]const u8) = .{};
    for (initial_aliases) |alias| {
        if (alias.len == 0) continue;
        if (!containsString(aliases.items, alias)) {
            try aliases.append(allocator, alias);
        }
    }

    try entries.append(allocator, .{
        .codepoint = codepoint,
        .name = try arena_allocator.dupe(u8, name),
        .block_name = block_name,
        .aliases = aliases,
    });
    try entry_index.put(codepoint, @intCast(entries.items.len - 1));
}

fn expandRange(
    arena_allocator: std.mem.Allocator,
    allocator: std.mem.Allocator,
    blocks: []const BlockRange,
    entries: *std.ArrayList(Entry),
    entry_index: *std.AutoHashMap(u32, u32),
    start: u32,
    end: u32,
    raw_label: []const u8,
    category: []const u8,
) !void {
    if (std.mem.eql(u8, category, "Cs") or std.mem.eql(u8, category, "Co")) return;

    const label = raw_label[1 .. raw_label.len - ", First>".len];
    if (std.mem.eql(u8, label, "Hangul Syllable")) {
        var cp = start;
        while (cp <= end) : (cp += 1) {
            const name = try makeHangulName(arena_allocator, cp);
            try addEntry(arena_allocator, allocator, blocks, entries, entry_index, cp, name, &.{});
        }
        return;
    }

    if (std.mem.startsWith(u8, label, "CJK Ideograph")) {
        var cp = start;
        while (cp <= end) : (cp += 1) {
            const name = try std.fmt.allocPrint(arena_allocator, "CJK UNIFIED IDEOGRAPH-{X}", .{cp});
            try addEntry(arena_allocator, allocator, blocks, entries, entry_index, cp, name, &.{});
        }
        return;
    }

    if (std.mem.startsWith(u8, label, "Tangut Ideograph")) {
        var cp = start;
        while (cp <= end) : (cp += 1) {
            const name = try std.fmt.allocPrint(arena_allocator, "TANGUT IDEOGRAPH-{X}", .{cp});
            try addEntry(arena_allocator, allocator, blocks, entries, entry_index, cp, name, &.{});
        }
    }
}

fn buildTrie(
    arena_allocator: std.mem.Allocator,
    allocator: std.mem.Allocator,
    entries: *std.ArrayList(Entry),
    trie_nodes: *std.ArrayList(TrieNodeBuilder),
) !void {
    for (entries.items, 0..) |entry, index| {
        var unique_terms: std.ArrayList([]const u8) = .{};
        defer unique_terms.deinit(allocator);

        try collectTerms(arena_allocator, allocator, &unique_terms, entry.name, entry.codepoint);
        for (entry.aliases.items) |alias| {
            try collectTerms(arena_allocator, allocator, &unique_terms, alias, entry.codepoint);
        }

        for (unique_terms.items) |term| {
            try trieInsert(allocator, trie_nodes, term, @intCast(index));
        }
    }

    for (trie_nodes.items) |*node| {
        std.sort.heap(TrieEdgeBuilder, node.children.items, {}, struct {
            fn lessThan(_: void, a: TrieEdgeBuilder, b: TrieEdgeBuilder) bool {
                return a.ch < b.ch;
            }
        }.lessThan);
    }
}

fn collectTerms(
    arena_allocator: std.mem.Allocator,
    allocator: std.mem.Allocator,
    terms: *std.ArrayList([]const u8),
    text: []const u8,
    codepoint: u32,
) !void {
    const normalized = try normalizeText(arena_allocator, text);
    if (normalized.len > 0) {
        var words = std.mem.splitScalar(u8, normalized, ' ');
        while (words.next()) |word| {
            try addUniqueTerm(allocator, terms, word);
        }
    }

    const code_term = try std.fmt.allocPrint(arena_allocator, "u+{x}", .{codepoint});
    const normalized_code = try normalizeText(arena_allocator, code_term);
    try addUniqueTerm(allocator, terms, normalized_code);
}

fn addUniqueTerm(allocator: std.mem.Allocator, terms: *std.ArrayList([]const u8), term: []const u8) !void {
    if (term.len == 0) return;
    for (terms.items) |existing| {
        if (std.mem.eql(u8, existing, term)) return;
    }
    try terms.append(allocator, term);
}

fn trieInsert(
    allocator: std.mem.Allocator,
    trie_nodes: *std.ArrayList(TrieNodeBuilder),
    term: []const u8,
    entry_index: u32,
) !void {
    var node_index: u32 = 0;
    for (term) |ch| {
        var next_index: ?u32 = null;
        for (trie_nodes.items[node_index].children.items) |edge| {
            if (edge.ch == ch) {
                next_index = edge.target;
                break;
            }
        }

        if (next_index == null) {
            const new_index: u32 = @intCast(trie_nodes.items.len);
            try trie_nodes.append(allocator, .{
                .children = .{},
                .payload = .{},
            });
            try trie_nodes.items[node_index].children.append(allocator, .{ .ch = ch, .target = new_index });
            next_index = new_index;
        }

        node_index = next_index.?;
        try appendPayload(allocator, &trie_nodes.items[node_index].payload, entry_index);
    }
}

fn appendPayload(allocator: std.mem.Allocator, payload: *std.ArrayList(u32), value: u32) !void {
    for (payload.items) |existing| {
        if (existing == value) return;
    }
    if (payload.items.len >= result_limit) return;
    try payload.append(allocator, value);
}

fn writeEntriesFile(allocator: std.mem.Allocator, out_dir: []const u8, entries: []const Entry) !void {
    const strings_path = try std.fs.path.join(allocator, &.{ out_dir, "strings.bin" });
    defer allocator.free(strings_path);
    const entries_path = try std.fs.path.join(allocator, &.{ out_dir, "entries.bin" });
    defer allocator.free(entries_path);

    var strings: std.ArrayList(u8) = .{};
    defer strings.deinit(allocator);
    var bytes: std.ArrayList(u8) = .{};
    defer bytes.deinit(allocator);

    try appendU32(&bytes, allocator, 0x314E4555);
    try appendU32(&bytes, allocator, @intCast(entries.len));

    for (entries) |entry| {
        const name_ref = try appendString(allocator, &strings, entry.name);
        const alias_ref = try appendJoinedAliases(allocator, &strings, entry.aliases.items);
        const block_ref = try appendString(allocator, &strings, entry.block_name);

        try appendU32(&bytes, allocator, entry.codepoint);
        try appendU32(&bytes, allocator, name_ref.offset);
        try appendU32(&bytes, allocator, name_ref.len);
        try appendU32(&bytes, allocator, alias_ref.offset);
        try appendU32(&bytes, allocator, alias_ref.len);
        try appendU32(&bytes, allocator, block_ref.offset);
        try appendU32(&bytes, allocator, block_ref.len);
    }

    var file = try std.fs.cwd().createFile(entries_path, .{ .truncate = true });
    defer file.close();
    try file.writeAll(bytes.items);

    var strings_file = try std.fs.cwd().createFile(strings_path, .{ .truncate = true });
    defer strings_file.close();
    try strings_file.writeAll(strings.items);
}

fn writeTrieFile(allocator: std.mem.Allocator, out_dir: []const u8, nodes: []const TrieNodeBuilder) !void {
    const trie_path = try std.fs.path.join(allocator, &.{ out_dir, "trie.bin" });
    defer allocator.free(trie_path);

    var edge_count: usize = 0;
    var payload_count: usize = 0;
    for (nodes) |node| {
        edge_count += node.children.items.len;
        payload_count += node.payload.items.len;
    }

    var bytes: std.ArrayList(u8) = .{};
    defer bytes.deinit(allocator);

    try appendU32(&bytes, allocator, 0x31525455);
    try appendU32(&bytes, allocator, @intCast(nodes.len));
    try appendU32(&bytes, allocator, @intCast(edge_count));
    try appendU32(&bytes, allocator, @intCast(payload_count));

    var running_edge_offset: u32 = 0;
    var running_payload_offset: u32 = 0;
    for (nodes) |node| {
        try appendU32(&bytes, allocator, running_edge_offset);
        try appendU16(&bytes, allocator, @intCast(node.children.items.len));
        try appendU32(&bytes, allocator, running_payload_offset);
        try appendU16(&bytes, allocator, @intCast(node.payload.items.len));

        running_edge_offset += @intCast(node.children.items.len);
        running_payload_offset += @intCast(node.payload.items.len);
    }

    for (nodes) |node| {
        for (node.children.items) |edge| {
            try bytes.append(allocator, edge.ch);
            try appendU32(&bytes, allocator, edge.target);
        }
    }

    for (nodes) |node| {
        for (node.payload.items) |payload| {
            try appendU24(&bytes, allocator, payload);
        }
    }

    var file = try std.fs.cwd().createFile(trie_path, .{ .truncate = true });
    defer file.close();
    try file.writeAll(bytes.items);
}

fn writeMetaFile(
    allocator: std.mem.Allocator,
    out_dir: []const u8,
    entry_count: usize,
    nodes: []const TrieNodeBuilder,
) !void {
    var edge_count: usize = 0;
    var payload_count: usize = 0;
    for (nodes) |node| {
        edge_count += node.children.items.len;
        payload_count += node.payload.items.len;
    }

    const meta_path = try std.fs.path.join(allocator, &.{ out_dir, "meta.json" });
    defer allocator.free(meta_path);

    const json = try std.fmt.allocPrint(allocator,
        \\{{
        \\  "version": "17.0.0",
        \\  "resultLimit": {d},
        \\  "entries": {{
        \\    "count": {d},
        \\    "recordSize": {d},
        \\    "headerSize": {d},
        \\    "file": "entries.bin"
        \\  }},
        \\  "trie": {{
        \\    "nodeCount": {d},
        \\    "edgeCount": {d},
        \\    "payloadCount": {d},
        \\    "headerSize": {d},
        \\    "nodeSize": {d},
        \\    "edgeSize": {d},
        \\    "payloadIndexSize": {d},
        \\    "file": "trie.bin"
        \\  }},
        \\  "strings": {{
        \\    "file": "strings.bin"
        \\  }}
        \\}}
    , .{
        result_limit,
        entry_count,
        entry_record_size,
        entries_header_size,
        nodes.len,
        edge_count,
        payload_count,
        trie_header_size,
        trie_node_size,
        trie_edge_size,
        trie_payload_index_size,
    });
    defer allocator.free(json);

    try std.fs.cwd().writeFile(.{
        .sub_path = meta_path,
        .data = json,
    });
}

fn appendString(allocator: std.mem.Allocator, strings: *std.ArrayList(u8), text: []const u8) !struct { offset: u32, len: u32 } {
    const offset: u32 = @intCast(strings.items.len);
    try strings.appendSlice(allocator, text);
    return .{
        .offset = offset,
        .len = @intCast(text.len),
    };
}

fn appendJoinedAliases(
    allocator: std.mem.Allocator,
    strings: *std.ArrayList(u8),
    aliases: []const []const u8,
) !struct { offset: u32, len: u32 } {
    if (aliases.len == 0) {
        return .{ .offset = @intCast(strings.items.len), .len = 0 };
    }

    const offset: u32 = @intCast(strings.items.len);
    for (aliases, 0..) |alias, index| {
        if (index > 0) {
            try strings.appendSlice(allocator, " • ");
        }
        try strings.appendSlice(allocator, alias);
    }

    return .{
        .offset = offset,
        .len = @as(u32, @intCast(strings.items.len)) - offset,
    };
}

fn appendU32(bytes: *std.ArrayList(u8), allocator: std.mem.Allocator, value: u32) !void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, value, .little);
    try bytes.appendSlice(allocator, &buf);
}

fn appendU16(bytes: *std.ArrayList(u8), allocator: std.mem.Allocator, value: u16) !void {
    var buf: [2]u8 = undefined;
    std.mem.writeInt(u16, &buf, value, .little);
    try bytes.appendSlice(allocator, &buf);
}

fn appendU24(bytes: *std.ArrayList(u8), allocator: std.mem.Allocator, value: u32) !void {
    try bytes.append(allocator, @intCast(value & 0xff));
    try bytes.append(allocator, @intCast((value >> 8) & 0xff));
    try bytes.append(allocator, @intCast((value >> 16) & 0xff));
}

fn normalizeText(allocator: std.mem.Allocator, text: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .{};
    var previous_space = true;

    for (text) |byte| {
        const ch = switch (byte) {
            'A'...'Z' => byte + 32,
            'a'...'z', '0'...'9', '+' => byte,
            '-', '_', ' ', '\t', '/', '\\', '.', ',', ':', ';', '(', ')', '[', ']', '{', '}', '\'' => ' ',
            else => 0,
        };

        if (ch == 0) continue;
        if (ch == ' ') {
            if (previous_space) continue;
            previous_space = true;
            try out.append(allocator, ' ');
        } else {
            previous_space = false;
            try out.append(allocator, ch);
        }
    }

    if (out.items.len > 0 and out.items[out.items.len - 1] == ' ') {
        _ = out.pop();
    }

    return out.toOwnedSlice(allocator);
}

fn containsString(values: []const []const u8, needle: []const u8) bool {
    for (values) |value| {
        if (std.mem.eql(u8, value, needle)) return true;
    }
    return false;
}

fn findBlock(blocks: []const BlockRange, codepoint: u32) []const u8 {
    for (blocks) |block| {
        if (codepoint >= block.start and codepoint <= block.end) return block.name;
    }
    return "";
}

fn isRangeFirst(name: []const u8) bool {
    return std.mem.endsWith(u8, name, ", First>");
}

fn isRangeLast(name: []const u8) bool {
    return std.mem.endsWith(u8, name, ", Last>");
}

fn makeHangulName(allocator: std.mem.Allocator, codepoint: u32) ![]const u8 {
    const l_table = [_][]const u8{ "G", "GG", "N", "D", "DD", "R", "M", "B", "BB", "S", "SS", "", "J", "JJ", "C", "K", "T", "P", "H" };
    const v_table = [_][]const u8{ "A", "AE", "YA", "YAE", "EO", "E", "YEO", "YE", "O", "WA", "WAE", "OE", "YO", "U", "WEO", "WE", "WI", "YU", "EU", "YI", "I" };
    const t_table = [_][]const u8{ "", "G", "GG", "GS", "N", "NJ", "NH", "D", "L", "LG", "LM", "LB", "LS", "LT", "LP", "LH", "M", "B", "BS", "S", "SS", "NG", "J", "C", "K", "T", "P", "H" };

    const s_index = codepoint - 0xAC00;
    const l_index = s_index / 588;
    const v_index = (s_index % 588) / 28;
    const t_index = s_index % 28;

    return std.fmt.allocPrint(allocator, "HANGUL SYLLABLE {s}{s}{s}", .{
        l_table[l_index],
        v_table[v_index],
        t_table[t_index],
    });
}
