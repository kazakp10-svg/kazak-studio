import assert from "node:assert/strict";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNodeRuntime } from "./fetch-node.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.env.APP_VERSION || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const architecture = process.arch === "x64" ? "x86_64" : process.arch;
const output = resolve(process.argv[2] || join(root, ".local", "release"));
const app = join(output, "KAZAK studio.app");
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
const runtime = join(resources, "runtime");
const releaseBuild = process.env.RELEASE_BUILD === "1";
const feedURL = process.env.SPARKLE_FEED_URL || "";
const publicKey = process.env.SPARKLE_PUBLIC_KEY || "";

assert.match(version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, "APP_VERSION must be semver");
assert(!existsSync(app), `Output already exists: ${app}`);
assert.equal(
  architecture,
  process.env.APP_ARCH || architecture,
  "APP_ARCH does not match the Node/runtime architecture",
);
if (releaseBuild) {
  assert.match(feedURL, /^https:\/\//, "SPARKLE_FEED_URL is required for releases");
  assert.match(publicKey, /^[A-Za-z0-9+/]{43}=$/, "SPARKLE_PUBLIC_KEY must be a base64 EdDSA public key");
}

mkdirSync(resources, { recursive: true });
mkdirSync(join(resources, "node", "bin"), { recursive: true });
mkdirSync(runtime, { recursive: true });
for (const name of ["server.mjs", "lib.mjs", "archive.mjs", "launch.mjs", "package.json", "public"])
  cpSync(join(root, name), join(runtime, name), { recursive: true });
const probeBin = join(root, "node_modules", "ffprobe-static", "bin");
cpSync(join(root, "node_modules"), join(runtime, "node_modules"), {
  recursive: true,
  filter: (path) => !path.startsWith(probeBin),
});
cpSync(join(probeBin, "darwin", process.arch), join(runtime, "node_modules", "ffprobe-static", "bin", "darwin", process.arch), { recursive: true });
const runtimeNode = process.env.NODE_RUNTIME_BIN && statSync(process.env.NODE_RUNTIME_BIN).size > 1_000_000
  ? { path: process.env.NODE_RUNTIME_BIN }
  : await fetchNodeRuntime(join(root, ".local", "release-tools", `node-v22.23.3-${process.arch}`));
copyFileSync(runtimeNode.path, join(resources, "node", "bin", "node"));
chmodSync(join(resources, "node", "bin", "node"), 0o755);

const binPath = execFileSync("swift", ["build", "-c", "release", "--show-bin-path"], { cwd: root, encoding: "utf8" }).trim();
const executable = join(binPath, "kazak-studio");
assert(existsSync(executable), `Build the native launcher first: ${executable}`);
mkdirSync(join(contents, "MacOS"), { recursive: true });
copyFileSync(executable, join(contents, "MacOS", "kazak-studio"));
const frameworkSource = join(binPath, "Sparkle.framework");
const frameworkTarget = join(contents, "Frameworks", "Sparkle.framework");
assert(existsSync(frameworkSource), `Sparkle framework is missing: ${frameworkSource}`);
mkdirSync(dirname(frameworkTarget), { recursive: true });
execFileSync("/usr/bin/ditto", [frameworkSource, frameworkTarget]);
execFileSync("/usr/bin/install_name_tool", ["-add_rpath", "@executable_path/../Frameworks", join(contents, "MacOS", "kazak-studio")]);

const iconWork = join(root, ".local", "icon-build");
const iconset = join(iconWork, "AppIcon.iconset");
mkdirSync(iconset, { recursive: true });
execFileSync("swift", [join(root, "tools", "icon.swift"), iconWork], { cwd: root, stdio: "inherit" });
for (const size of [16, 32, 128, 256, 512]) {
  copyFileSync(join(iconWork, `${size}.png`), join(iconset, `icon_${size}x${size}.png`));
  copyFileSync(join(iconWork, `${size * 2}.png`), join(iconset, `icon_${size}x${size}@2x.png`));
}
mkdirSync(join(contents, "Resources"), { recursive: true });
execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(contents, "Resources", "AppIcon.icns")]);

const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const updater = releaseBuild ? `<key>SUFeedURL</key><string>${xml(feedURL)}</string><key>SUPublicEDKey</key><string>${xml(publicKey)}</string><key>SUEnableAutomaticChecks</key><true/><key>SUAutomaticallyUpdate</key><false/><key>SUScheduledCheckInterval</key><integer>21600</integer><key>SUVerifyUpdateBeforeExtraction</key><true/>` : "";
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleInfoDictionaryVersion</key><string>6.0</string><key>CFBundleName</key><string>KAZAK studio</string><key>CFBundleDisplayName</key><string>KAZAK studio</string><key>CFBundleIdentifier</key><string>local.kazak.apistudio</string><key>CFBundleExecutable</key><string>kazak-studio</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${xml(version)}</string><key>CFBundleVersion</key><string>${xml(version)}</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>LSUIElement</key><true/><key>CFBundleIconFile</key><string>AppIcon</string>${updater}</dict></plist>`;
writeFileSync(join(contents, "Info.plist"), plist);
execFileSync("/usr/bin/plutil", ["-lint", join(contents, "Info.plist")]);
assert(existsSync(join(runtime, "node_modules", "ffmpeg-static", "ffmpeg")));
assert(existsSync(join(runtime, "node_modules", "ffprobe-static", "bin", "darwin", architecture === "x86_64" ? "x64" : architecture)));
console.log(`Готово: ${app} (${architecture}, ${version})`);
