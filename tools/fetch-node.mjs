import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export async function fetchNodeRuntime(output, version = "22.23.3", arch = process.arch) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "Invalid Node.js version");
  assert.ok(["arm64", "x64"].includes(arch), "Only Apple silicon and Intel Macs are supported");
  const nodePath = resolve(output);
  mkdirSync(dirname(nodePath), { recursive: true });
  const archive = `node-v${version}-darwin-${arch}.tar.xz`;
  const base = `https://nodejs.org/dist/v${version}`;
  const [archiveResponse, sumsResponse] = await Promise.all([fetch(`${base}/${archive}`), fetch(`${base}/SHASUMS256.txt`)]);
  assert.ok(archiveResponse.ok, `Node.js download failed: ${archiveResponse.status}`);
  assert.ok(sumsResponse.ok, `Node.js checksum download failed: ${sumsResponse.status}`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  const sums = await sumsResponse.text();
  const expected = sums.match(new RegExp(`^([a-f0-9]{64})\\s+${archive.replaceAll(".", "\\.")}\\s*$`, "m"))?.[1];
  assert.ok(expected, `Official checksum for ${archive} was not found`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, "Node.js archive checksum mismatch");

  const work = mkdtempSync(join(tmpdir(), "kazak-node-"));
  try {
    const archivePath = join(work, archive);
    writeFileSync(archivePath, bytes, { mode: 0o600 });
    execFileSync("tar", ["-xJf", archivePath, "-C", work, "--strip-components=2", `node-v${version}-darwin-${arch}/bin/node`]);
    const extracted = join(work, "node");
    chmodSync(extracted, 0o755);
    assert.equal(execFileSync(extracted, ["--version"], { encoding: "utf8" }).trim(), `v${version}`);
    copyFileSync(extracted, nodePath);
    chmodSync(nodePath, 0o755);
    return { path: nodePath, version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  assert.ok(output, "Usage: node tools/fetch-node.mjs <output-path> [version] [arch]");
  await fetchNodeRuntime(output, process.argv[3], process.argv[4]);
}
