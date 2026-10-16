import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  writeFileSync,
  createWriteStream,
  copyFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { check, id } from "./lib.mjs";
const exec = promisify(execFile);
const namePattern =
  /^media\/[a-f0-9-]{36}\.(png|jpg|jpeg|webp|mp4|mov|webm|mp3|wav|m4a)$/;
export async function makeBundle(root, manifest) {
  const bundleId = id(),
    scratch = join(root, "work", `bundle-${bundleId}`);
  mkdirSync(join(scratch, "media"), { recursive: true, mode: 0o700 });
  try {
    const assets = manifest.assets.map((a) => ({
      ...a,
      file: `${a.id}${extname(a.file)}`,
      folder: "media",
      thumbnail: undefined,
    }));
    writeFileSync(
      join(scratch, "project.json"),
      JSON.stringify({ ...manifest, assets }, null, 2),
      { mode: 0o600 },
    );
    for (const a of manifest.assets)
      copyFileSync(
        join(root, a.folder || "media", a.file),
        join(scratch, "media", `${a.id}${extname(a.file)}`),
      );
    const target = join(root, "exports", `${bundleId}.kazak`);
    await exec(
      "/usr/bin/tar",
      ["-czf", target, "-C", scratch, "project.json", "media"],
      {
        timeout: 600000,
        maxBuffer: 1000000,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      },
    );
    return bundleId;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
async function extractEntry(archive, entry, destination) {
  const proc = spawn("/usr/bin/tar", ["-xOzf", archive, entry], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let count = 0,
    error = "";
  proc.stderr.on("data", (d) => {
    error = (error + d).slice(-1000);
  });
  const completion = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Архив повреждён: ${error}`)),
    );
  });
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      callback(
        count > 1024 * 1024 * 1024
          ? new Error("Файл в архиве больше 1 ГБ.")
          : null,
        chunk,
      );
    },
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 180000);
  try {
    await Promise.all([
      pipeline(
        proc.stdout,
        limit,
        createWriteStream(destination, { mode: 0o600 }),
      ),
      completion,
    ]);
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
export async function unpackBundle(archive, root) {
  const scratch = join(root, "work", `import-${id()}`);
  mkdirSync(scratch, { mode: 0o700 });
  try {
    const { stdout } = await exec("/usr/bin/tar", ["-tzf", archive], {
      timeout: 30000,
      maxBuffer: 300000,
    });
    const entries = stdout.trim().split("\n");
    check(
      entries.length <= 1002 &&
        new Set(entries).size === entries.length &&
        entries.includes("project.json"),
      "Некорректная структура архива.",
    );
    check(
      entries.every(
        (s) => s === "project.json" || s === "media/" || namePattern.test(s),
      ),
      "Архив содержит недопустимые пути.",
    );
    const { stdout: json } = await exec(
      "/usr/bin/tar",
      ["-xOzf", archive, "project.json"],
      { timeout: 30000, maxBuffer: 2000000 },
    );
    const manifest = JSON.parse(json);
    check(
      manifest.version === 1 &&
        Array.isArray(manifest.assets) &&
        manifest.assets.length <= 1000,
      "Неизвестный формат проекта.",
    );
    const files = manifest.assets.map((a) => `media/${a.file}`);
    check(
      new Set(files).size === files.length &&
        files.every((f) => namePattern.test(f) && entries.includes(f)),
      "Медиа в архиве не совпадают с паспортом.",
    );
    let total = 0;
    // shortcut: one tar scan per asset keeps extraction safe; use a streaming archive reader for projects with hundreds of large assets.
    for (const f of files) {
      const target = join(scratch, f.slice(6));
      await extractEntry(archive, f, target);
      total += statSync(target).size;
      check(
        total <= 4 * 1024 * 1024 * 1024,
        "Распакованный проект больше 4 ГБ.",
      );
    }
    return { manifest, scratch };
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    throw e;
  }
}
