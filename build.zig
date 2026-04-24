const std = @import("std");

pub fn build(b: *std.Build) void {
    const builtin = @import("builtin");
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const out_dir = "dist/data";

    const exe = b.addExecutable(.{
        .name = "unicode-picker-data",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    if (b.args) |args| {
        run.addArgs(args);
    } else {
        run.addArg("UCD");
        run.addArg(out_dir);
    }

    const run_step = b.step("run", "Generate unicode picker data");
    if (builtin.os.tag == .windows) {
        const compress = b.addSystemCommand(&.{
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "scripts/compress-data.ps1",
            out_dir,
        });
        compress.step.dependOn(&run.step);
        run_step.dependOn(&compress.step);
    } else {
        run_step.dependOn(&run.step);
    }
}
