import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  createReadStream,
  createWriteStream,
  unlinkSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  rmSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import { join, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import ffmpeg from "ffmpeg-static";
import ffprobePackage from "ffprobe-static";
import { models, modelFor, validateModelInput } from "./public/models.js";
import {
  DEFAULT_EPISODE,
  DEFAULT_SCENE,
  GLOSSARY,
  describeStructure,
  migrateStructure,
  moveItem,
  orderedStructure,
  renameHeading,
  syncFromScript,
} from "./public/structure.js";
import { makeBundle, unpackBundle } from "./archive.mjs";
import {
  id,
  defaults,
  check,
  textValue,
  finite,
  atomicJSON,
  loadStore,
  projectFields,
  shotFields,
  validateTimeline,
  validateEstimate,
  reservedCost,
  klingToken,
  seedanceBody,
  klingBody,
  parseVideo,
  isPublicIP,
  pinnedLookup,
  validMediaHeader,
  codexError,
} from "./lib.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));
const appVersion = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};
const KEY_NAMES = [
  "openaiKey",
  "openrouterKey",
  "deepseekKey",
  "anthropicKey",
  "seedanceKey",
  "klingKey",
  "klingAccess",
  "klingSecret",
];
const seedBase = {
  modelark:
    "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
  las: "https://operator.las.ap-southeast-1.bytepluses.com/api/v1/contents/generations/tasks",
};

function safeSegment(value, fallback) {
  const name = String(value || "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 80);
  return name && name !== "." && name !== ".." ? name : fallback;
}

function projectFolderName(title, projectId) {
  return join("projects", `${safeSegment(title, "Фильм")}-${projectId.slice(0, 8)}`);
}

function shotPlace(project, shot) {
  const scene = project.scenes?.find((s) => s.id === shot.sceneId);
  const episode = project.episodes?.find((e) => e.id === scene?.episodeId);
  return { episode: episode?.title || DEFAULT_EPISODE, scene: scene?.title || DEFAULT_SCENE };
}

function projectFolders(root, project) {
  project.folder ||= projectFolderName(project.title, project.id);
  for (const folder of [
    "01-Сценарий",
    "02-Изображения/Референсы",
    "03-Видео/Библиотека",
    "04-Аудио",
    "05-Аниматик",
    "80-Проверка/Изображения",
    "80-Проверка/Видео",
    "80-Проверка/Звук",
    "90-Архив/Изображения",
    "90-Архив/Видео",
    "90-Архив/Звук",
  ])
    mkdirSync(join(root, project.folder, folder), { recursive: true, mode: 0o700 });
  for (const shot of project.shots || []) {
    const place = shotPlace(project, shot);
    const hierarchy = join(
      "Эпизоды", safeSegment(place.episode, DEFAULT_EPISODE),
      "Сцены", safeSegment(place.scene, DEFAULT_SCENE),
      "Шоты", safeSegment(shot.title || "Шот", "Шот"),
    );
    for (const folder of [
      ...["Начальный", "Конечный", "Референсы"].map((frame) =>
        join("02-Изображения", hierarchy, "Кадры", frame),
      ),
      join("03-Видео", hierarchy, "Видео"),
    ]) mkdirSync(join(root, project.folder, folder), { recursive: true, mode: 0o700 });
  }
}

function command(binary, args, { input, timeout = 300000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Превышено время обработки. Исходные файлы сохранены."));
    }, timeout);
    proc.stdout.on("data", (d) => {
      out = (out + d).slice(-2000000);
    });
    proc.stderr.on("data", (d) => {
      err = (err + d).slice(-10000);
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(out)
        : reject(new Error(err || `Процесс завершился с кодом ${code}.`));
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}

function vault(root, initial) {
  // Tests use disposable keys; real macOS keys live in the user's Keychain.
  if (initial) return { keys: initial, save() {} };
  if (process.platform === "darwin") {
    const service = `local.kino-terminal:${root}`;
    let keys = {};
    try {
      keys = JSON.parse(
        execFileSync(
          "/usr/bin/security",
          ["find-generic-password", "-a", "kino-terminal", "-s", service, "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
    } catch (e) {
      check(
        e.status === 44,
        "Не удалось открыть ключи в Связке ключей. Разрешите доступ и перезапустите приложение.",
        500,
      );
    }
    return {
      keys,
      save(next) {
        const quote = (s) =>
          '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
        try {
          execFileSync("/usr/bin/security", ["-i"], {
            input: `add-generic-password -a kino-terminal -s ${quote(service)} -U -w ${quote(JSON.stringify(next))}\n`,
            stdio: ["pipe", "pipe", "pipe"],
          });
          const stored = JSON.parse(
            execFileSync(
              "/usr/bin/security",
              [
                "find-generic-password",
                "-a",
                "kino-terminal",
                "-s",
                service,
                "-w",
              ],
              { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
            ),
          );
          check(
            JSON.stringify(stored) === JSON.stringify(next),
            "Проверка сохранения ключей не прошла.",
          );
        } catch {
          throw new Error(
            "Не удалось сохранить ключи в Связке ключей. Разрешите доступ в macOS и повторите сохранение.",
          );
        }
        this.keys = next;
      },
    };
  }
  const path = join(root, "keys.json");
  return {
    keys: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {},
    save(next) {
      atomicJSON(path, next);
      this.keys = next;
    },
  };
}

async function remoteJSON(url, key, body, method = body ? "POST" : "GET") {
  const multipart = body instanceof FormData;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body && !multipart ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(240000),
    redirect: "error",
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      `API вернул HTTP ${response.status} без JSON. Проверьте подключение.`,
    );
  }
  check(
    response.ok,
    result.error?.message || result.message || `API: HTTP ${response.status}`,
    502,
  );
  return result;
}

export async function streamText(url, key, body, provider, onText) {
  const response=await fetch(url,{method:"POST",headers:provider === "anthropic" ? {"x-api-key":key,"anthropic-version":"2023-06-01","Content-Type":"application/json"} : {Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({...body,stream:true}),signal:AbortSignal.timeout(240000),redirect:"error"});
  if(!response.ok) {const d=await response.json().catch(()=>({}));throw new Error(d.error?.message || `API: HTTP ${response.status}`);}
  let buffer="",usage,complete=false;
  const decoder=new TextDecoder();
  for await(const bytes of response.body) {
    buffer+=decoder.decode(bytes,{stream:true});
    let boundary;
    while((boundary=buffer.indexOf("\n"))>=0) {
      const line=buffer.slice(0,boundary).trim();buffer=buffer.slice(boundary+1);
      if(!line.startsWith("data:")) continue;
      const value=line.slice(5).trim();
      if(value === "[DONE]") {complete=true;continue;}
      const d=JSON.parse(value);
      if(d.error || d.type === "error") throw new Error(d.error?.message || "Ошибка потока API.");
      const delta=d.type === "response.output_text.delta" ? d.delta : d.type === "content_block_delta" ? d.delta?.text : d.choices?.[0]?.delta?.content;
      if(delta) onText(delta);
      usage=d.usage || d.response?.usage || usage;
      if(["response.completed","message_stop"].includes(d.type) || d.choices?.[0]?.finish_reason) complete=true;
      if(["response.failed","response.incomplete"].includes(d.type)) throw new Error("Ответ модели прерван. Полученный текст сохранён в задании.");
    }
  }
  check(complete,"Соединение оборвалось до завершения ответа. Полученный текст сохранён в задании.",502);
  return usage;
}

export async function downloadPublic(url, path, depth = 0, headers = {}) {
  check(depth < 5, "Слишком много перенаправлений при скачивании.");
  const u = new URL(url);
  check(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443"),
    "Видео должно скачиваться по публичному HTTPS.",
  );
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host, { all: true });
  check(
    addresses.length && addresses.every((a) => isPublicIP(a.address)),
    "Скачивание из локальной сети запрещено.",
  );
  const address = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const req = https.get(
      u,
      {
        headers,
        lookup: pinnedLookup(address),
      },
      resolve,
    );
    req.setTimeout(120000, () =>
      req.destroy(new Error("Скачивание заняло слишком много времени.")),
    );
    req.on("error", reject);
  });
  if (
    response.statusCode >= 300 &&
    response.statusCode < 400 &&
    response.headers.location
  ) {
    response.resume();
    const next = new URL(response.headers.location, u);
    return downloadPublic(next.href, path, depth + 1, next.origin === u.origin ? headers : {});
  }
  check(
    response.statusCode === 200,
    `Не удалось скачать видео: HTTP ${response.statusCode}.`,
    502,
  );
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, cb) {
      bytes += chunk.length;
      cb(
        bytes > 1024 * 1024 * 1024 ? new Error("Видео больше 1 ГБ.") : null,
        chunk,
      );
    },
  });
  const timer = setTimeout(
    () => response.destroy(new Error("Превышено время скачивания.")),
    180000,
  );
  try {
    await pipeline(response, limit, createWriteStream(path, { mode: 0o600 }));
  } finally {
    clearTimeout(timer);
  }
}

export function createStudio({
  root = process.platform === "darwin"
    ? join(
        homedir(),
        "Library",
        "Application Support",
        "KAZAK studio API",
        "data",
      )
    : join(appDir, ".local"),
  keys,
  request = remoteJSON,
  download = downloadPublic,
  revealFolder = (path) => command("/usr/bin/open", [path], { timeout: 30000 }),
} = {}) {
  const { data, save: saveStore } = loadStore(root);
  const transientProjects = new Map();
  const save = () => saveStore();
  data.settings = { ...defaults, ...data.settings };
  if ("seedanceService" in data.settings) {
    delete data.settings.seedanceService;
    save();
  }
  for (const p of data.projects) { p.cards ||= []; p.shots.forEach(s=>s.referenceIds ||= []); }
  if (data.projects.map((p) => migrateStructure(p, id)).some(Boolean)) {
    if (existsSync(join(root, "studio.json")))
      copyFileSync(join(root, "studio.json"), join(root, "backups", `studio-before-structure-${Date.now()}.json`));
    save();
  }
  const secrets = vault(root, keys);
  const busy = new Set();
  let exporting = false;
  const sanitize = (message) =>
    KEY_NAMES.reduce(
      (s, k) =>
        secrets.keys[k] ? s.replaceAll(secrets.keys[k], "[ключ скрыт]") : s,
      String(message),
    ).slice(0, 3000);
  const getProject = (projectId) => {
    const p = data.projects.find((p) => p.id === projectId);
    check(p, "Проект не найден.", 404);
    return p;
  };
  const getAsset = (assetId, projectId) => {
    const a = data.assets.find(
      (a) => a.id === assetId && (!projectId || a.projectId === projectId),
    );
    check(a, "Файл не найден.", 404);
    return a;
  };
  const libraryAsset = (assetId, projectId) => {
    const a = getAsset(assetId, projectId);
    check((a.collection || "library") === "library", "Сначала добавьте материал в библиотеку.");
    return a;
  };
  const file = (a) => join(root, a.folder || "media", a.file);
  const projectFor = (projectId) =>
    data.projects.find((p) => p.id === projectId) || transientProjects.get(projectId);
  const ensureProjectFolder = (p) => projectFolders(root, p);
  function assetFolder(a, collection = a.collection || "library") {
    const p = projectFor(a.projectId);
    check(p, "Проект не найден.", 404);
    const type = a.kind === "image" ? "Изображения" : a.kind === "audio" ? "Звук" : "Видео";
    let base = collection === "archive"
      ? `90-Архив/${type}`
      : collection === "review"
        ? `80-Проверка/${type}`
        : a.kind === "audio"
          ? "04-Аудио"
          : a.role === "film-export"
            ? "03-Видео/Экспорт"
            : a.kind === "image"
              ? "02-Изображения"
              : "03-Видео";
    if (a.kind === "audio" || a.role === "film-export") return join(p.folder, base);
    const shot = p.shots?.find((s) => s.id === a.shotId);
    if (!shot) return join(p.folder, base, a.kind === "image" ? "Референсы" : "Библиотека");
    const place = shotPlace(p, shot);
    return join(
      p.folder,
      base,
      "Эпизоды",
      safeSegment(place.episode, DEFAULT_EPISODE),
      "Сцены",
      safeSegment(place.scene, DEFAULT_SCENE),
      "Шоты",
      safeSegment(shot.title || "Шот", "Шот"),
      a.kind === "image"
        ? join("Кадры", shot.referenceId === a.id ? "Начальный" : shot.endReferenceId === a.id ? "Конечный" : "Референсы")
        : "Видео",
    );
  }
  const assetFilename = (a) => {
    const ext = extname(a.file).toLowerCase();
    const label = String(a.name || a.kind).toLowerCase().endsWith(ext)
      ? a.name.slice(0, -ext.length)
      : a.name;
    return `${a.id.slice(0, 8)} ${safeSegment(label, a.kind)}${ext}`;
  };
  function placeAsset(a) {
    const oldPath = file(a), folder = assetFolder(a), name = assetFilename(a), nextPath = join(root, folder, name);
    mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });
    if (oldPath !== nextPath) {
      if (existsSync(oldPath)) {
        if (existsSync(nextPath)) unlinkSync(nextPath);
        renameSync(oldPath, nextPath);
      } else check(existsSync(nextPath), "Файл материала не найден.", 404);
      a.folder = folder;
      a.file = name;
    }
  }
  function writeProjectFolder(p) {
    ensureProjectFolder(p);
    const assets = data.assets.filter((a) => a.projectId === p.id).map((a) => ({
      ...a,
      folder: relative(p.folder, a.folder || "media"),
      thumbnail: undefined,
    }));
    const project = { ...p };
    delete project.folder;
    writeFileSync(join(root, p.folder, "01-Сценарий", "Сценарий.md"), p.script || "", { mode: 0o600 });
    writeFileSync(join(root, p.folder, "project.json"), JSON.stringify({
      version: 1,
      project,
      assets,
      jobs: data.jobs.filter((j) => j.projectId === p.id).map(({ resultUrl, ...j }) => j),
    }, null, 2), { mode: 0o600 });
  }
  function relocateShotAssets(p) {  // folder names follow scene, episode and shot titles
    for (const a of data.assets.filter((a) => a.projectId === p.id && a.shotId)) {
      try { placeAsset(a); }
      catch (e) { process.emitWarning(`Не удалось переложить материал ${a.id}: ${e.message}`); }
    }
  }
  function relocateProjectFolder(p, title) {
    const next = projectFolderName(title, p.id), old = p.folder;
    if (old === next) return;
    if (existsSync(join(root, old))) renameSync(join(root, old), join(root, next));
    p.folder = next;
    for (const a of data.assets.filter((a) => a.projectId === p.id && a.folder?.startsWith(`${old}/`)))
      a.folder = `${next}${a.folder.slice(old.length)}`;
  }
  const needsStorageMigration = data.projects.some((p) => !p.folder) || data.assets.some((a) => {
    const p = data.projects.find((p) => p.id === a.projectId), folder = p?.folder || projectFolderName(p?.title, p?.id || "");
    return !a.collection || !p || !a.folder?.startsWith(`${folder}/`);
  });
  let storageChanged = data.projects.some((p) => !p.folder);
  if (needsStorageMigration && existsSync(join(root, "studio.json"))) {
    copyFileSync(join(root, "studio.json"), join(root, "backups", `studio-before-folders-${Date.now()}.json`));
  }
  for (const p of data.projects) ensureProjectFolder(p);
  for (const a of data.assets) {
    if (!a.collection) { a.collection = "library"; storageChanged = true; }
    const p = data.projects.find((p) => p.id === a.projectId);
    if (p && !a.folder?.startsWith(`${p.folder}/`)) {
      try { placeAsset(a); storageChanged = true; }
      catch (e) { process.emitWarning(`Не удалось разложить материал ${a.id}: ${e.message}`); }
    }
  }
  if (storageChanged) save();
  const backup = (p) => atomicJSON(join(root, "backups", `${p.id}.json`), p);
  async function probe(path) {
    const header = Buffer.alloc(16),
      fd = openSync(path, "r");
    try {
      readSync(fd, header, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    check(
      validMediaHeader(header, extname(path)),
      "Содержимое файла не соответствует поддерживаемому медиаформату.",
    );
    const d = JSON.parse(
      await command(
        ffprobePackage.path,
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          path,
        ],
        { timeout: 20000 },
      ),
    );
    const video = d.streams.find(
      (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
    );
    const audio = d.streams.some((s) => s.codec_type === "audio");
    return {
      duration: Number(d.format.duration) || 0,
      width: video?.width || 0,
      height: video?.height || 0,
      hasAudio: audio,
      video: !!video,
    };
  }
  async function register(
    path,
    {
      projectId,
      shotId = null,
      name,
      kind,
      jobId,
      folder = "media",
      collection = "library",
      role = folder === "exports" ? "film-export" : undefined,
      commit = true,
    },
  ) {
    const a = {
      id: extname(path) ? path.split("/").pop().split(".")[0] : id(),
      file: path.split("/").pop(),
      projectId,
      shotId,
      name,
      kind,
      jobId,
      folder,
      collection,
      role,
      createdAt: new Date().toISOString(),
      bytes: statSync(path).size,
    };
    const meta = await probe(path);
    if (kind === "image")
      check(meta.video && meta.width > 0, "Файл не является изображением.");
    if (kind === "video")
      check(meta.video && meta.duration > 0, "Файл не является видео.");
    if (kind === "audio")
      check(meta.hasAudio && meta.duration > 0, "Файл не содержит аудио.");
    Object.assign(a, {
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
    });
    if (kind !== "audio") {
      a.thumbnail = `${a.id}.jpg`;
      await command(
        ffmpeg,
        [
          "-v",
          "error",
          "-y",
          "-i",
          path,
          "-frames:v",
          "1",
          "-vf",
          "scale=640:-2",
          join(root, "media", a.thumbnail),
        ],
        { timeout: 30000 },
      );
    }
    placeAsset(a);
    if (commit) {
      data.assets.push(a);
      save();
      try { writeProjectFolder(projectFor(projectId)); }
      catch (e) { process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`); }
    }
    return a;
  }
  function reference(job, raw = false, assetId = job.referenceId, video = true) {
    if (!assetId) return null;
    const a = libraryAsset(assetId, job.projectId);
    check(a.kind === "image", "Для референса выберите изображение.");
    const bytes = readFileSync(file(a));
    check(
      bytes.length <= (raw ? 10 : 30) * 1024 * 1024,
      "Референс превышает лимит провайдера.",
    );
    if (raw)
      check(
        [".jpg", ".jpeg", ".png"].includes(extname(a.file)),
        "Kling принимает PNG и JPEG.",
      );
    if (video) check(
      a.width >= 300 &&
        a.height >= 300 &&
        a.width / a.height >= 0.4 &&
        a.width / a.height <= 2.5,
      "Видео API: референс должен быть от 300 px, пропорции от 1:2.5 до 2.5:1.",
    );
    const b64 = bytes.toString("base64");
    return raw ? b64 : `data:${TYPES[extname(a.file)]};base64,${b64}`;
  }
  function credential(provider) {
    if (provider === "kling") return klingToken(secrets.keys);
    const env={openai:"OPENAI_API_KEY", seedance:"BYTEPLUS_API_KEY", openrouter:"OPENROUTER_API_KEY", deepseek:"DEEPSEEK_API_KEY",anthropic:"ANTHROPIC_API_KEY"};
    const key=secrets.keys[`${provider}Key`] || process.env[env[provider]];
    check(key,`Добавьте ключ ${provider} в подключениях.`);
    return key;
  }
  async function quote(input, project) {
    if (input.kind === "assistant") return {amount:input.provider === "local" || input.provider === "sonnet" ? 0 : data.settings.assistantReserve,source:"Резерв на ответ",basis:"reserve"};
    const m=modelFor(input,data.settings); validateModelInput(m,input);
    if(m.kind === "image") return {amount:data.settings.imageReserve * ({low:0.5,medium:1,high:2}[input.quality || "medium"]),source:"Резерв на изображение",basis:"reserve"};
    const resolution=input.resolution || "720p", pixels={"480p":854*480,"720p":1280*720,"1080p":1920*1080,"4k":4096*2160}[resolution];
    if(m.provider === "seedance" && m.id === "seedance-2-direct") return {amount:+(pixels*24*input.duration/1024*(resolution === "1080p"?7.7:7)/1e6).toFixed(4),source:"Тариф ModelArk",basis:"estimate"};
    if(m.provider === "kling") return {amount:input.duration*data.settings.klingSecondRate,source:"Ваш тариф Kling",basis:"reserve"};
    if(m.provider === "seedance") {
      // shortcut: ModelArk USD on-demand rates for image/text input; update if pricing or video-reference support changes.
      const customRate=data.settings.seedance25TokenRate,rate=customRate>0?customRate:({"480p":10.7,"720p":10.7,"1080p":11.7}[resolution]);
      check(rate > 0, "Для Seedance 2.5 неизвестен тариф этого разрешения.");
      return {amount:+(pixels*24*input.duration/1024*rate/1e6).toFixed(4),source:`Тариф ModelArk${customRate>0?", свой":""}, $${rate.toFixed(2)} за млн токенов`,basis:"estimate"};
    }
    if(m.provider === "openrouter" && ["seedance-2-mini-openrouter","seedance-2-openrouter","seedance-25-openrouter"].includes(m.id)) {
      const rate=m.id === "seedance-2-mini-openrouter"?3.5:m.id === "seedance-2-openrouter"?7:10.7;
      const inference=pixels*24*input.duration/1024*rate/1e6;
      return {amount:+(inference*1.055).toFixed(4),source:`Тариф модели $${rate.toFixed(2)} за млн токенов, плюс 5.5% за пополнение`,basis:"estimate"};
    }
    if(m.provider === "openrouter" && ["kling-3-std-openrouter","kling-3-pro-openrouter"].includes(m.id)) {
      const rate=m.id === "kling-3-std-openrouter"?(input.sound?0.126:0.084):(input.sound?0.168:0.112);
      return {amount:+(input.duration*rate*1.055).toFixed(4),source:`$${rate.toFixed(3)} за секунду${input.sound?" со звуком":" без звука"}, плюс 5.5% за пополнение`,basis:"estimate"};
    }
    check(false,"Для этой модели нет расчёта стоимости.");
  }
  async function finishVideo(job, result) {
    const parsed = job.provider === "openrouter" ? {state:result.status === "completed" ? "succeeded" : result.status === "failed" || result.status === "cancelled" ? "failed" : "waiting",url:result.unsigned_urls?.[0],error:result.error,usage:result.usage} : parseVideo(job.provider, result);
    job.remoteStatus = parsed.state;
    job.usage = parsed.usage || job.usage;
    if (["failed", "expired", "cancelled"].includes(parsed.state)) {
      job.status = "failed";
      job.error = parsed.error || "Провайдер отклонил задание.";
      save();
      return;
    }
    if (parsed.state !== "succeeded") {
      job.status = "waiting";
      job.lastPoll = new Date().toISOString();
      job.pollError = null;
      save();
      return;
    }
    check(parsed.url, "API завершил задание без ссылки на видео.", 502);
    job.resultUrl = parsed.url;
    job.status = "downloading";
    save();
    const path = join(root, "media", `${id()}.mp4`);
    try {
      await download(parsed.url, path, 0, job.provider === "openrouter" ? {Authorization:`Bearer ${credential("openrouter")}`} : {});
      const asset = await register(path, {
        projectId: job.projectId,
        shotId: job.shotId,
        name: `${getProject(job.projectId).shots.find((s) => s.id === job.shotId)?.title || "Дубль"}, ${job.provider}`,
        kind: "video",
        jobId: job.id,
        collection: "review",
      });
      job.assetId = asset.id;
      job.status = "succeeded";
      job.error = job.pollError = null;
      job.completedAt = new Date().toISOString();
      save();
    } catch (e) {
      if (existsSync(path)) unlinkSync(path);
      job.status = "download_failed";
      job.error = sanitize(e.message);
      save();
    }
  }
  async function poll(job) {
    if (busy.has(job.id)) return;
    busy.add(job.id);
    try {
      if (job.status === "download_failed" && job.resultUrl)
        await finishVideo(job, job.provider === "openrouter" ? {status:"completed",unsigned_urls:[job.resultUrl],usage:job.usage} : job.provider === "seedance" ? {status:"succeeded",content:{video_url:job.resultUrl}} : {code:0,data:{task_status:"succeed",task_result:{videos:[{url:job.resultUrl}]}}});
      else if (job.provider === "openrouter") {
        check(/^[a-zA-Z0-9_-]+$/.test(job.remoteId || ""), "Неверный ID задания OpenRouter.");
        const status=await request(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(job.remoteId)}`,credential("openrouter"));
        if(status.status === "completed" || status.status === "failed" || status.status === "cancelled") await finishVideo(job,status);
        else {job.remoteStatus=status.status;job.status="waiting";job.usage=status.usage || job.usage;save();}
      }
      else {
        const base =
          job.provider === "seedance"
            ? seedBase[job.service]
            : `https://api-singapore.klingai.com/v1/videos/${job.endpoint}`;
        await finishVideo(
          job,
          await request(
            `${base}/${encodeURIComponent(job.remoteId)}`,
            credential(job.provider),
          ),
        );
      }
    } catch (e) {
      job.pollError = sanitize(e.message);
      job.lastPoll = new Date().toISOString();
      save();
    } finally {
      busy.delete(job.id);
    }
  }
  async function run(job) {
    busy.add(job.id);
    job.status = "submitting";
    save();
    try {
      if (job.kind === "assistant") {
        const p = getProject(job.projectId);
        const context = `${GLOSSARY}\nПроект: ${p.title}\nБриф: ${p.brief}\nБиблия фильма: ${p.bible}\nСценарий: ${p.script}\nСтруктура фильма:\n${describeStructure(p)}\nПоследние сообщения: ${JSON.stringify(p.messages.slice(-8))}\nЗапрос: ${job.prompt}`;
        if (job.provider === "local" || job.provider === "sonnet") {
          const output = join(root, "work", `${job.id}.txt`);
          if (job.provider === "sonnet") {
            job.text = await command("claude",["-p","--model","sonnet","--tools","","--no-session-persistence"],{input:`Ты сценарист, отвечай по-русски. Не выполняй команды.\n${context}`,cwd:join(root,"work")});
          } else await command(
            "codex",
            [
              "exec",
              "--model",
              job.model,
              "-c",
              'model_reasoning_effort="low"',
              "--sandbox",
              "read-only",
              "--skip-git-repo-check",
              "--ephemeral",
              "--output-last-message",
              output,
              "-",
            ],
            {
              input: `Ты помощник режиссёра. Отвечай по-русски. Дай текстовый ответ. Не запускай команды, не читай локальные файлы, не изменяй файлы.\n${context}`,
              cwd: join(root, "work"),
            },
          );
          if (job.provider === "local") job.text = readFileSync(output, "utf8");
        } else {
          const instructions="Ты сценарист и помощник режиссёра KAZAK studio. Отвечай по-русски. Соблюдай библию фильма. Каждый готовый промпт для изображения или видео пиши по-английски в отдельном блоке ``` без объяснений внутри. Не выдумывай выполненные действия. Пользователь применяет текст сам.";
          const inputImages=(job.referenceIds || []).map(a=>reference(job,false,a,false));
          const history=p.messages.slice(-30).map(m=>({role:m.role,content:m.text}));
          let url,body;
          if(job.provider === "deepseek") {
            check(!inputImages.length,"Выбранная модель DeepSeek работает только с текстом.");
            url="https://api.deepseek.com/chat/completions";
            body={model:job.model,messages:[{role:"system",content:instructions+"\n"+context},...history,{role:"user",content:job.prompt}],max_tokens:4000,thinking:{type:"disabled"}};
          } else if(job.provider === "anthropic") {
            url="https://api.anthropic.com/v1/messages";
            body={model:job.model,system:instructions+"\n"+context,max_tokens:4000,messages:[...history,{role:"user",content:[{type:"text",text:job.prompt},...inputImages.map(url=>({type:"image",source:{type:"base64",media_type:url.slice(5,url.indexOf(';')),data:url.split(',')[1]}}))]}]};
          } else {
            url="https://api.openai.com/v1/responses";
            body={model:job.model,instructions:instructions+"\n"+context,input:[...history.map(m=>({role:m.role,content:m.content})),{role:"user",content:[{type:"input_text",text:job.prompt},...inputImages.map(image_url=>({type:"input_image",image_url}))]}],max_output_tokens:4000,store:false};
          }
          if(request === remoteJSON) {
            job.text="";
            job.status="running";save();
            job.usage=await streamText(url,credential(job.provider),body,job.provider,(delta)=>{job.text=(job.text+delta).slice(0,100000);});
          } else {
            const d=await request(url,credential(job.provider),body);
            job.text=d.choices?.[0]?.message?.content || d.content?.filter(c=>c.type==="text").map(c=>c.text).join("\n") || d.output?.flatMap(o=>o.content || []).filter(c=>c.type==="output_text").map(c=>c.text).join("\n");
            job.usage=d.usage;
          }
        }
        check(job.text, "Модель не вернула текст.");
        p.messages.push(
          { id: id(), role: "user", text: job.prompt, jobId: job.id },
          {
            id: id(),
            role: "assistant",
            text: job.text,
            jobId: job.id,
            model: job.model,
          },
        );
      } else if (job.kind === "image") {
        let d;
        if (job.referenceIds?.length || job.referenceId) {
          const refIds=job.referenceIds?.length ? job.referenceIds : [job.referenceId];
          const form = new FormData();
          for (const [k, v] of Object.entries({
            model: job.model,
            prompt: job.prompt,
            size: job.size,
            quality: job.quality,
            n: "1",
          }))
            form.append(k, v);
          for (const refId of refIds) {
            const a=getAsset(refId,job.projectId);
            form.append("image[]",new Blob([readFileSync(file(a))],{type:TYPES[extname(a.file)]}),a.file);
          }
          d = await request(
            "https://api.openai.com/v1/images/edits",
            credential("openai"),
            form,
          );
        } else
          d = await request(
            "https://api.openai.com/v1/images/generations",
            credential("openai"),
            {
              model: job.model,
              prompt: job.prompt,
              size: job.size,
              quality: job.quality,
              n: 1,
              output_format: "png",
            },
          );
        check(d.data?.[0]?.b64_json, "API не вернул изображение.", 502);
        const path = join(root, "media", `${id()}.png`);
        writeFileSync(path, Buffer.from(d.data[0].b64_json, "base64"), {
          mode: 0o600,
        });
        const asset = await register(path, {
          projectId: job.projectId,
          shotId: job.shotId,
          name: "Референс GPT Image",
          kind: "image",
          jobId: job.id,
          collection: "review",
        });
        job.assetId = asset.id;
        job.usage = d.usage;
      } else {
        let d;
        if (job.provider === "seedance")
          d = await request(
            seedBase[job.service],
            credential("seedance"),
            seedanceBody(job, reference(job), reference(job,false,job.endReferenceId), (job.referenceIds || []).map(a=>reference(job,false,a))),
          );
        else if(job.provider === "openrouter") {
          const m=models.find(m=>m.id===job.modelId),input={model:m.api,prompt:job.prompt,duration:job.duration,generate_audio:job.sound};
          if(m.resolutions.length) input.resolution=job.resolution;
          if(job.referenceId) input.frame_images=[{type:"image_url",image_url:{url:reference(job,false,job.referenceId)},frame_type:"first_frame"}];
          if(job.endReferenceId) input.frame_images=[...(input.frame_images || []),{type:"image_url",image_url:{url:reference(job,false,job.endReferenceId)},frame_type:"last_frame"}];
          if(job.referenceIds?.length) input.input_references=job.referenceIds.map(a=>({type:"image_url",image_url:{url:reference(job,false,a)}}));
          if(!job.referenceId) input.aspect_ratio=job.ratio;
          check([...job.referenceIds,job.referenceId,job.endReferenceId].filter(Boolean).reduce((n,a)=>n+libraryAsset(a,job.projectId).bytes,0)<=32*1024*1024,"Для OpenRouter суммарный размер референсов ограничен 32 МБ.");
          save();
          const sub=await request("https://openrouter.ai/api/v1/videos",credential("openrouter"),input);
          job.remoteId=sub.id;
          check(typeof job.remoteId === "string" && /^[a-zA-Z0-9_-]+$/.test(job.remoteId),"OpenRouter не вернул ID задания.");
          job.status="waiting";save();return;
        }
        else {
          job.endpoint = job.referenceId ? "image2video" : "text2video";
          save();
          d = await request(
            `https://api-singapore.klingai.com/v1/videos/${job.endpoint}`,
            credential("kling"),
            klingBody(job, reference(job, true)),
          );
          check(d.code === 0, d.message || "Kling отклонил запрос.", 502);
        }
        job.remoteId = job.provider === "seedance" ? d.id : d.data?.task_id;
        check(
          typeof job.remoteId === "string" && job.remoteId,
          "API не вернул ID задания.",
          502,
        );
        job.status = "waiting";
        save();
        return;
      }
      job.status = "succeeded";
      job.completedAt = new Date().toISOString();
      save();
    } catch (e) {
      job.status = ["local","sonnet"].includes(job.provider) ? "failed" : "uncertain";
      job.error =
        ["local","sonnet"].includes(job.provider)
          ? `Codex CLI: ${sanitize(codexError(e.message))}. Проверьте модель Codex в «Подключениях» и вход в CLI.`
          : sanitize(e.message) +
            " Новое платное задание не отправлялось повторно. Проверьте историю провайдера.";
      save();
    } finally {
      busy.delete(job.id);
    }
  }
  async function render(job) {
    exporting = true;
    job.status = "running";
    save();
    const scratch = join(root, "work", job.id);
    mkdirSync(scratch, { mode: 0o700 });
    try {
      const p = getProject(job.projectId),
        clips = job.timeline;
      const [w, h] =
        job.ratio === "9:16"
          ? [1080, 1920]
          : job.ratio === "1:1"
            ? [1080, 1080]
            : [1920, 1080];
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i],
          a = libraryAsset(c.assetId, p.id),
          duration = c.end - c.start;
        const args = [
          "-hide_banner",
          "-v",
          "error",
          "-y",
          "-ss",
          String(c.start),
          "-i",
          file(a),
        ];
        const silence = c.muted || !a.hasAudio;
        if (silence)
          args.push(
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
          );
        args.push(
          "-t",
          String(duration),
          "-map",
          "0:v:0",
          "-map",
          silence ? "1:a:0" : "0:a:0",
          "-vf",
          `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`,
          "-af",
          "apad",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-ac",
          "2",
          join(scratch, `${i}.mp4`),
        );
        await command(ffmpeg, args, { timeout: 600000 });
        job.progress = Math.round(((i + 1) / (clips.length + 1)) * 100);
        save();
      }
      const list = join(scratch, "concat.txt");
      writeFileSync(list, clips.map((_c, i) => `file '${i}.mp4'`).join("\n"));
      const stitched = join(scratch, "cut.mp4");
      await command(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        list,
        "-c",
        "copy",
        stitched,
      ]);
      const output = join(root, "exports", `${id()}.mp4`);
      if (job.musicId) {
        const music = libraryAsset(job.musicId, p.id),
          seconds = clips.reduce((n, c) => n + c.end - c.start, 0);
        await command(ffmpeg, [
          "-v",
          "error",
          "-y",
          "-i",
          stitched,
          "-stream_loop",
          "-1",
          "-i",
          file(music),
          "-filter_complex",
          `[1:a]volume=${job.musicVolume}[music];[0:a][music]amix=inputs=2:duration=first:normalize=0[a]`,
          "-map",
          "0:v:0",
          "-map",
          "[a]",
          "-t",
          String(seconds),
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          output,
        ]);
      } else
        await command(ffmpeg, [
          "-v",
          "error",
          "-y",
          "-i",
          stitched,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          output,
        ]);
      const a = await register(output, {
        projectId: p.id,
        name: `${p.title}, монтаж`,
        kind: "video",
        jobId: job.id,
        folder: "exports",
      });
      job.assetId = a.id;
      job.status = "succeeded";
      job.progress = 100;
      job.completedAt = new Date().toISOString();
      save();
    } catch (e) {
      job.status = "failed";
      job.error = sanitize(e.message);
      save();
    } finally {
      exporting = false;
    }
  }

  for (const j of data.jobs) {
    if (["queued", "submitting", "running"].includes(j.status)) {
      j.status = "uncertain";
      j.error =
        "Приложение было закрыто во время обработки. Проверьте историю провайдера; платный запрос не повторён.";
    }
    if (j.status === "downloading") j.status = "download_failed";
  }
  save();
  const ticker = setInterval(() => {
    for (const j of data.jobs)
      if (j.status === "waiting" && j.remoteId) void poll(j);
  }, 10000);
  ticker.unref();
  const summary = () => ({
    ...data,
    appId: "kazak-studio",
    version: appVersion,
    models,
    connections: {
      openai: !!(secrets.keys.openaiKey || process.env.OPENAI_API_KEY),
      openrouter: !!(secrets.keys.openrouterKey || process.env.OPENROUTER_API_KEY),
      deepseek: !!(secrets.keys.deepseekKey || process.env.DEEPSEEK_API_KEY),
      anthropic: !!(secrets.keys.anthropicKey || process.env.ANTHROPIC_API_KEY),
      seedance: !!secrets.keys.seedanceKey,
      kling: !!(
        secrets.keys.klingKey ||
        (secrets.keys.klingAccess && secrets.keys.klingSecret)
      ),
      storage:
        process.platform === "darwin"
          ? "macOS Keychain"
          : "Локальный файл с правами 600",
    },
    capabilities: {
      ffmpeg: existsSync(ffmpeg),
      sonnet: existsSync(join(homedir(),".local/bin/claude")),
      codex:
        existsSync("/opt/homebrew/bin/codex") ||
        existsSync("/usr/local/bin/codex"),
    },
    estimatedSpend: Object.fromEntries(
      data.projects.map((p) => [p.id, reservedCost(data.jobs, p.id)]),
    ),
  });
  async function readJSON(req) {
    let chunks = [],
      length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      check(length <= 2 * 1024 * 1024, "Запрос больше 2 МБ.", 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      throw Object.assign(new Error("Некорректный JSON."), { status: 400 });
    }
  }
  function send(res, value, status = 200) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  function streamFile(req, res, path, type) {
    check(existsSync(path), "Файл не найден.", 404);
    const total = statSync(path).size,
      range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      check(m, "Неверный диапазон.", 416);
      const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
      const end = m[1]
        ? m[2]
          ? Math.min(Number(m[2]), total - 1)
          : total - 1
        : total - 1;
      check(start <= end && start < total, "Неверный диапазон.", 416);
      res.writeHead(206, {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": end - start + 1,
      });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": total,
        "Accept-Ranges": "bytes",
      });
      createReadStream(path).pipe(res);
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const expected = `127.0.0.1:${server.address().port}`;
      check(
        req.headers.host === expected,
        "Доступ разрешён только через локальный адрес приложения.",
        403,
      );
      if (req.headers.origin)
        check(
          req.headers.origin === `http://${expected}`,
          "Запрос из другого сайта запрещён.",
          403,
        );
      check(
        !req.headers["sec-fetch-site"] ||
          ["same-origin", "none"].includes(req.headers["sec-fetch-site"]),
        "Межсайтовый запрос запрещён.",
        403,
      );
      if (!["GET", "HEAD"].includes(req.method))
        check(
          req.headers["x-studio-request"] === "1",
          "Запрос должен исходить из приложения.",
          403,
        );
      const u = new URL(req.url, `http://${expected}`),
        path = u.pathname;
      if (req.method === "GET" && path === "/api/state")
        return send(res, summary());
      if (req.method === "GET" && path === "/api/project-export") {
        const p = getProject(u.searchParams.get("id"));
        return send(res, {
          version: 1,
          project: p,
          assets: data.assets.filter((a) => a.projectId === p.id),
          jobs: data.jobs.filter((j) => j.projectId === p.id),
        });
      }
      if (req.method === "POST" && path === "/api/project-folder") {
        const p = getProject((await readJSON(req)).projectId);
        writeProjectFolder(p);
        await revealFolder(join(root, p.folder));
        return send(res, { ok: true });
      }
      if (req.method === "GET" && path.startsWith("/bundle/")) {
        const bundleId = path.split("/")[2];
        check(/^[a-f0-9-]{36}$/.test(bundleId), "Архив не найден.", 404);
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="project.kazak"',
        );
        return streamFile(
          req,
          res,
          join(root, "exports", `${bundleId}.kazak`),
          "application/gzip",
        );
      }
      if (req.method === "POST" && path === "/api/bundle") {
        const b = await readJSON(req),
          p = getProject(b.projectId);
        const bundleId = await makeBundle(root, {
          version: 1,
          project: structuredClone(p),
          assets: data.assets.filter((a) => a.projectId === p.id),
          jobs: data.jobs
            .filter((j) => j.projectId === p.id)
            .map(({ resultUrl, ...j }) => j),
        });
        return send(res, {
          url: `/bundle/${bundleId}`,
          name: `${p.title}.kazak`,
        });
      }
      if (req.method === "POST" && path === "/api/import-project") {
        const archive = join(root, "work", `${id()}.kazak`);
        let bytes = 0,
          unpacked;
        const limiter = new Transform({
          transform(chunk, _e, cb) {
            bytes += chunk.length;
            cb(
              bytes > 2 * 1024 * 1024 * 1024
                ? new Error("Архив больше 2 ГБ.")
                : null,
              chunk,
            );
          },
        });
        const added = [],
          copiedTargets = [];
        let provisionalId = null, provisionalFolder = null, imported = false;
        try {
          await pipeline(
            req,
            limiter,
            createWriteStream(archive, { mode: 0o600 }),
          );
          unpacked = await unpackBundle(archive, root);
          const m = unpacked.manifest;
          const fields = projectFields(m.project);
          check(fields.title?.trim(), "В архиве нет названия фильма.");
          check(
            Array.isArray(m.project.shots) &&
              m.project.shots.length <= 500 &&
              Array.isArray(m.project.messages) &&
              m.project.messages.length <= 1000,
            "Некорректный сценарий проекта.",
          );
          const projectId = id(),
            assetMap = new Map(),
            shotMap = new Map();
          provisionalId = projectId;
          migrateStructure(m.project, id);  // archives from earlier versions keep episode and scene as text on shots
          check(m.project.episodes.length <= 200 && m.project.scenes.length <= 1000, "Некорректная структура фильма.");
          const episodeMap = new Map(),
            sceneMap = new Map();
          const episodes = m.project.episodes.map((e) => {
            const next = { id: id(), title: textValue(e.title, 200) };
            episodeMap.set(e.id, next.id);
            return next;
          });
          const scenes = m.project.scenes.map((sc) => {
            const next = { id: id(), episodeId: episodeMap.get(sc.episodeId) || episodes[0].id, title: textValue(sc.title, 200), fromScript: !!sc.fromScript };
            sceneMap.set(sc.id, next.id);
            return next;
          });
          const shots = m.project.shots.map((s) => {
            check(
              typeof s.id === "string" && !shotMap.has(s.id),
              "Повторяющийся ID шота.",
            );
            const next = { id: id(), ...shotFields(s), sceneId: sceneMap.get(s.sceneId) || scenes[0]?.id };
            shotMap.set(s.id, next.id);
            return next;
          });
          const importingProject = {
            id: projectId,
            title: fields.title,
            folder: projectFolderName(fields.title, projectId),
            episodes,
            scenes,
            shots,
          };
          provisionalFolder = importingProject.folder;
          transientProjects.set(projectId, importingProject);
          ensureProjectFolder(importingProject);
          for (const original of m.assets) {
            check(
              typeof original.id === "string" &&
                !assetMap.has(original.id) &&
                ["image", "video", "audio"].includes(original.kind) &&
                (!original.collection || ["library", "review", "archive"].includes(original.collection)),
              "Некорректный медиафайл.",
            );
            const target = join(
              root,
              "media",
              `${id()}${extname(original.file)}`,
            );
            copyFileSync(join(unpacked.scratch, original.file), target);
            copiedTargets.push(target);
            const a = await register(target, {
              projectId,
              shotId: shotMap.get(original.shotId) || null,
              name: textValue(original.name, 200),
              kind: original.kind,
              collection: original.collection || "library",
              role: original.role === "film-export" ? "film-export" : undefined,
              commit: false,
            });
            added.push(a);
            assetMap.set(original.id, a.id);
          }
          for (const s of shots) {
            if (s.referenceId) {
              check(
                assetMap.has(s.referenceId),
                "В архиве отсутствует референс.",
              );
              s.referenceId = assetMap.get(s.referenceId);
              check(
                added.find((a) => a.id === s.referenceId)?.kind === "image",
                "Референс не является изображением.",
              );
            }
          }
          for(const shot of shots) {
            shot.referenceIds=(shot.referenceIds || []).map(a=>{check(assetMap.has(a),"Нет референса в архиве.");return assetMap.get(a);});
            if(shot.selectedVideoId) shot.selectedVideoId=assetMap.get(shot.selectedVideoId) || null;
            if(shot.endReferenceId) {check(assetMap.has(shot.endReferenceId),"Нет конечного кадра в архиве.");shot.endReferenceId=assetMap.get(shot.endReferenceId);}
          }
          const cards=(m.project.cards || []).map(c=>({id:id(),title:textValue(c.title,200),category:textValue(c.category,50),description:textValue(c.description || "",10000),assetIds:(c.assetIds || []).map(a=>{check(assetMap.has(a),"Нет изображения карточки в архиве.");return assetMap.get(a);})}));
          const messages = m.project.messages.map((msg) => {
            check(
              ["user", "assistant"].includes(msg.role),
              "Неизвестный тип сообщения.",
            );
            return {
              id: id(),
              role: msg.role,
              text: textValue(msg.text, 100000),
              model:
                typeof msg.model === "string"
                  ? textValue(msg.model, 200)
                  : undefined,
            };
          });
          check(Array.isArray(m.project.timeline), "Некорректный монтаж.");
          const timeline = validateTimeline(
            m.project.timeline.map((c) => ({
              ...c,
              id: id(),
              assetId: assetMap.get(c.assetId),
            })),
            added.filter((a) => (a.collection || "library") === "library"),
          );
          const musicId = m.project.musicId
            ? assetMap.get(m.project.musicId)
            : null;
          if (m.project.musicId)
            check(
              added.find((a) => a.id === musicId && (a.collection || "library") === "library")?.kind === "audio",
              "В архиве нет звуковой дорожки.",
            );
          const project = {
            id: projectId,
            folder: provisionalFolder,
            brief: "",
            script: "",
            bible: "",
            ratio: "16:9",
            budget: null,
            ...fields,
            episodes,
            scenes,
            shots,
            cards,
            messages,
            timeline,
            musicId,
            musicVolume: finite(
              m.project.musicVolume ?? 0.25,
              0,
              1,
              "громкость",
            ),
            revision: 0,
            createdAt: new Date().toISOString(),
          };
          check(
            Array.isArray(m.jobs) && m.jobs.length <= 10000,
            "Некорректная история заданий.",
          );
          const importedJobs = m.jobs.map((j) => ({
            id: id(),
            projectId,
            shotId: shotMap.get(j.shotId) || null,
            assetId: assetMap.get(j.assetId) || null,
            kind: ["image", "video", "assistant", "export"].includes(j.kind)
              ? j.kind
              : "assistant",
            provider: ["openai", "seedance", "kling", "local", "openrouter", "deepseek", "anthropic", "sonnet"].includes(
              j.provider,
            )
              ? j.provider
              : "local",
            model: textValue(j.model || "", 200),
            modelId: j.modelId ? textValue(j.modelId,100) : undefined,
            prompt: textValue(j.prompt || "", 100000),
            referenceId: assetMap.get(j.referenceId) || null,
            referenceIds: (j.referenceIds || []).map((a) => { check(assetMap.has(a),"Нет референса в архиве."); return assetMap.get(a); }),
            endReferenceId: j.endReferenceId ? assetMap.get(j.endReferenceId) || null : null,
            resolution: j.resolution ? textValue(j.resolution,20) : undefined,
            duration:
              j.duration === undefined
                ? undefined
                : finite(j.duration, 0, 3600, "длительность"),
            ratio: ["16:9", "9:16", "1:1"].includes(j.ratio)
              ? j.ratio
              : undefined,
            quality: ["low", "medium", "high"].includes(j.quality)
              ? j.quality
              : undefined,
            size: j.size ? textValue(j.size, 100) : undefined,
            sound: j.sound === undefined ? undefined : !!j.sound,
            usage:
              j.usage &&
              typeof j.usage === "object" &&
              JSON.stringify(j.usage).length <= 10000
                ? j.usage
                : undefined,
            estimate: finite(j.estimate || 0, 0, 10000, "оценка"),
            status: "archived",
            originalStatus: textValue(j.status || "", 100),
            remoteId: j.remoteId ? textValue(j.remoteId, 200) : undefined,
            createdAt: new Date(j.createdAt).toISOString(),
          }));
          data.projects.push(project);
          data.assets.push(...added);
          data.jobs.push(...importedJobs);
          transientProjects.delete(projectId);
          save();
          try { writeProjectFolder(project); }
          catch (e) { process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`); }
          imported = true;
          return send(res, project, 201);
        } catch (e) {
          for (const target of copiedTargets)
            if (existsSync(target)) unlinkSync(target);
          for (const a of added) {
            data.assets = data.assets.filter((x) => x.id !== a.id);
            if (existsSync(file(a))) unlinkSync(file(a));
            if (a.thumbnail && existsSync(join(root, "media", a.thumbnail)))
              unlinkSync(join(root, "media", a.thumbnail));
          }
          save();
          throw e;
        } finally {
          if (provisionalId) transientProjects.delete(provisionalId);
          if (provisionalFolder && !imported) rmSync(join(root, provisionalFolder), { recursive: true, force: true });
          if (existsSync(archive)) unlinkSync(archive);
          if (unpacked)
            rmSync(unpacked.scratch, { recursive: true, force: true });
        }
      }
      if (
        req.method === "GET" &&
        (path.startsWith("/media/") || path.startsWith("/thumb/"))
      ) {
        const a = getAsset(path.split("/")[2]);
        return streamFile(
          req,
          res,
          path.startsWith("/thumb/")
            ? join(root, "media", a.thumbnail || "missing")
            : file(a),
          path.startsWith("/thumb/")
            ? "image/jpeg"
            : TYPES[extname(a.file)] || "application/octet-stream",
        );
      }
      if (req.method === "POST" && path === "/api/upload") {
        const p = getProject(u.searchParams.get("projectId")),
          shotId = u.searchParams.get("shotId");
        if (shotId)
          check(
            p.shots.some((s) => s.id === shotId),
            "Шот не найден.",
          );
        const name = textValue(u.searchParams.get("name") || "Медиа", 200),
          ext = extname(name).toLowerCase();
        const kind = [".png", ".jpg", ".jpeg", ".webp"].includes(ext)
          ? "image"
          : [".mp4", ".mov", ".webm"].includes(ext)
            ? "video"
            : [".mp3", ".wav", ".m4a"].includes(ext)
              ? "audio"
              : null;
        check(
          kind,
          "Поддерживаются PNG, JPG, WebP, MP4, MOV, WebM, MP3, WAV и M4A.",
        );
        const target = join(root, "media", `${id()}${ext}`);
        let bytes = 0;
        const limiter = new Transform({
          transform(chunk, _e, cb) {
            bytes += chunk.length;
            cb(
              bytes > 1024 * 1024 * 1024
                ? new Error("Файл больше 1 ГБ.")
                : null,
              chunk,
            );
          },
        });
        try {
          await pipeline(
            req,
            limiter,
            createWriteStream(target, { mode: 0o600 }),
          );
          return send(
            res,
            await register(target, { projectId: p.id, shotId, name, kind }),
          );
        } catch (e) {
          if (existsSync(target)) unlinkSync(target);
          throw e;
        }
      }
      if (req.method === "GET" && ["/", "/app.js", "/style.css", "/models.js", "/structure.js", "/favicon.svg"].includes(path))
        return streamFile(
          req,
          res,
          join(appDir, "public", path === "/" ? "index.html" : path.slice(1)),
          TYPES[extname(path === "/" ? "index.html" : path)],
        );
      if (req.method === "POST" && path === "/api/settings") {
        const body = await readJSON(req),
          next = { ...secrets.keys };
        for (const k of KEY_NAMES)
          if (body[k]) {
            check(
              typeof body[k] === "string" &&
                body[k].length <= 4096 &&
                /^[\x20-\x7E]+$/.test(body[k]),
              "Неверный формат ключа.",
            );
            next[k] = body[k];
          }
        if (body.removeKeys) {
          check(
            Array.isArray(body.removeKeys) &&
              body.removeKeys.every((k) => KEY_NAMES.includes(k)),
            "Некорректный список ключей.",
          );
          for (const k of body.removeKeys) delete next[k];
        }
        const settings = { ...data.settings };
        for (const k of [
          "textModel",
          "deepseekModel",
          "anthropicModel",
          "codexModel",
          "imageModel",
          "seedanceModel",
          "klingModel",
        ])
          if (k in body) {
            check(
              typeof body[k] === "string" &&
                /^[a-zA-Z0-9._-]{1,120}$/.test(body[k]),
              "Неверное имя модели.",
            );
            settings[k] = body[k];
          }
        for(const k of ["imageReserve","assistantReserve","klingSecondRate"]) if(k in body) settings[k]=finite(Number(body[k]),0.001,100,"резерв");
        if ("seedance25TokenRate" in body) settings.seedance25TokenRate = body.seedance25TokenRate === "" ? 0 : finite(Number(body.seedance25TokenRate),0.001,1000,"тариф Seedance 2.5");
        if (KEY_NAMES.some((k) => body[k]) || body.removeKeys?.length)
          secrets.save(next);
        data.settings = settings;
        save();
        return send(res, summary());
      }
      if (req.method === "POST" && path === "/api/check-openai") {
        const result = await request(
          "https://api.openai.com/v1/models",
          credential("openai"),
        );
        return send(res, { models: result.data?.map((m) => m.id) || [] });
      }
      if (req.method === "POST" && path === "/api/projects") {
        const b = projectFields(await readJSON(req));
        check(b.title?.trim(), "Введите название фильма.");
        const projectId = id();
        const p = {
          id: projectId,
          folder: projectFolderName(b.title, projectId),
          title: b.title,
          brief: "",
          script: "",
          bible: "",
          ratio: "16:9",
          budget: null,
          cards: [],
          episodes: [{ id: id(), title: DEFAULT_EPISODE }],
          scenes: [],
          shots: [],
          timeline: [],
          musicId: null,
          musicVolume: 0.25,
          messages: [],
          revision: 0,
          createdAt: new Date().toISOString(),
          ...b,
        };
        ensureProjectFolder(p);
        data.projects.push(p);
        save();
        try { writeProjectFolder(p); }
        catch (e) { process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`); }
        return send(res, p, 201);
      }
      if (req.method === "POST" && path === "/api/restore") {
        const b = await readJSON(req),
          p = getProject(b.projectId);
        check(
          b.revision === p.revision,
          "Проект изменился. Обновите страницу.",
          409,
        );
        const snapshot = join(root, "backups", `${p.id}.json`);
        check(
          existsSync(snapshot),
          "Для этого проекта ещё нет сохранённой предыдущей версии.",
        );
        const previous = JSON.parse(readFileSync(snapshot, "utf8"));
        check(previous.id === p.id, "Копия не соответствует проекту.");
        backup(p);
        Object.assign(p, previous, { revision: p.revision + 1 });
        migrateStructure(p, id);
        relocateShotAssets(p);
        save();
        return send(res, p);
      }
      if (req.method === "POST" && path === "/api/split") {
        const b = await readJSON(req),
          p = getProject(b.projectId);
        check(
          b.revision === p.revision,
          "Монтаж изменился. Обновите страницу.",
          409,
        );
        const total = p.timeline.reduce((n, c) => n + c.end - c.start, 0),
          position = finite(b.position, 0, total, "позиция");
        let offset = 0,
          index = -1,
          cut;
        for (let i = 0; i < p.timeline.length; i++) {
          const c = p.timeline[i],
            duration = c.end - c.start;
          if (position > offset + 0.04 && position < offset + duration - 0.04) {
            index = i;
            cut = c.start + position - offset;
            break;
          }
          offset += duration;
        }
        check(
          index >= 0,
          "Поставьте указатель внутрь клипа, минимум в одном кадре от края.",
        );
        backup(p);
        const c = p.timeline[index];
        p.timeline.splice(
          index,
          1,
          { ...c, end: cut },
          { ...c, id: id(), start: cut },
        );
        p.revision++;
        save();
        return send(res, p);
      }
      if (req.method === "PATCH" && path.startsWith("/api/projects/")) {
        const p = getProject(path.split("/")[3]),
          b = await readJSON(req);
        check(
          b.revision === p.revision,
          "Проект изменён в другом окне. Обновите страницу перед сохранением.",
          409,
        );
        const fields = projectFields(b);
        if ("title" in fields) check(fields.title.trim(), "Введите название.");
        const timeline =
          "timeline" in b
            ? validateTimeline(
                b.timeline,
                data.assets.filter((a) => a.projectId === p.id && (a.collection || "library") === "library"),
              )
            : p.timeline;
        let musicId = p.musicId;
        if ("musicId" in b) {
          musicId = b.musicId;
          if (musicId)
            check(libraryAsset(musicId, p.id).kind === "audio", "Выберите аудио.");
          else musicId = null;
        }
        const musicVolume =
          "musicVolume" in b
            ? finite(b.musicVolume, 0, 1, "громкость")
            : p.musicVolume;
        const changed =
          Object.entries(fields).some(([k, v]) => p[k] !== v) ||
          JSON.stringify(timeline) !== JSON.stringify(p.timeline) ||
          musicId !== p.musicId ||
          musicVolume !== p.musicVolume;
        if (!changed) return send(res, p);
        backup(p);
        if (fields.title && fields.title !== p.title) relocateProjectFolder(p, fields.title);
        Object.assign(p, fields, {
          timeline,
          musicId,
          musicVolume,
          revision: p.revision + 1,
        });
        if ("script" in fields && syncFromScript(p, id)) relocateShotAssets(p);
        save();
        try { writeProjectFolder(p); }
        catch (e) { process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`); }
        return send(res, p);
      }
      if (req.method === "POST" && path === "/api/shots") {
        const b = await readJSON(req),
          p = getProject(b.projectId);
        check(p.shots.length < 500, "В проекте уже 500 шотов.");
        const s = {
          id: id(),
          title: "Новый шот",
          description: "",
          imagePrompt: "",
          videoPrompt: "",
          notes: "",
          duration: 5,
          status: "planned",
          referenceId: null,
          ...shotFields(b),
        };
        check(!s.sceneId || p.scenes.some((x) => x.id === s.sceneId), "Сцена не найдена.", 404);
        if (s.referenceId)
          check(
            libraryAsset(s.referenceId, p.id).kind === "image",
            "Выберите изображение.",
          );
        backup(p);
        if (!s.sceneId) {  // a new shot joins the last scene; the first one starts the first scene
          const last = orderedStructure(p).flatMap((g) => g.scenes).at(-1)?.scene;
          if (last) s.sceneId = last.id;
          else {
            const scene = { id: id(), episodeId: p.episodes[0].id, title: DEFAULT_SCENE, fromScript: false };
            p.scenes.push(scene);
            s.sceneId = scene.id;
          }
        }
        p.shots.push(s);
        p.revision++;
        save();
        try { writeProjectFolder(p); }
        catch (e) { process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`); }
        return send(res, s, 201);
      }
      if (req.method === "PATCH" && path.startsWith("/api/shots/")) {
        const b = await readJSON(req),
          p = getProject(b.projectId),
          s = p.shots.find((s) => s.id === path.split("/")[3]);
        check(s, "Шот не найден.", 404);
        check(
          b.revision === p.revision,
          "Шот изменён в другом окне. Обновите страницу.",
          409,
        );
        const fields = shotFields(b);
        if (fields.sceneId) check(p.scenes.some((x) => x.id === fields.sceneId), "Сцена не найдена.", 404);
        for (const ref of [...(fields.referenceIds || []), fields.endReferenceId].filter(Boolean)) check(libraryAsset(ref,p.id).kind === "image","Выберите изображение.");
        if (fields.referenceId)
          check(
            libraryAsset(fields.referenceId, p.id).kind === "image",
            "Выберите изображение.",
          );
        if(fields.selectedVideoId) check(libraryAsset(fields.selectedVideoId,p.id).kind === "video","Выберите видео.");
        backup(p);
        const movedScene = fields.sceneId && fields.sceneId !== s.sceneId;
        Object.assign(s, fields);
        if (movedScene) { p.shots.splice(p.shots.indexOf(s), 1); p.shots.push(s); }  // lands at the end of its new scene
        const referenced=new Set([...(s.referenceIds||[]),s.referenceId,s.endReferenceId].filter(Boolean));for(const a of data.assets.filter(a=>a.projectId===p.id&&(a.shotId===s.id||referenced.has(a.id)))){if(referenced.has(a.id))a.shotId=s.id;placeAsset(a);}
        p.revision++;
        save();
        try { writeProjectFolder(p); }
        catch (e) { process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`); }
        return send(res, s);
      }
      if(req.method === "DELETE" && path.startsWith("/api/shots/")) {
        const b=await readJSON(req),p=getProject(b.projectId),deleted=path.split("/")[3];check(b.revision === p.revision,"Шоты изменены в другом окне.",409);
        backup(p);p.shots=p.shots.filter(s=>s.id!==deleted);for(const a of data.assets.filter(a=>a.projectId===p.id&&a.shotId===deleted)){a.shotId=null;placeAsset(a);}p.revision++;save();try{writeProjectFolder(p);}catch(e){process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`);}return send(res,{ok:true});
      }
      if (["/api/scenes", "/api/episodes", "/api/move"].includes(path) || /^\/api\/(scenes|episodes)\//.test(path)) {
        const b = await readJSON(req),
          p = getProject(b.projectId),
          [, , kind, itemId] = path.split("/");
        check(b.revision === p.revision, "Проект изменён в другом окне. Обновите страницу.", 409);
        const list = kind === "episodes" ? p.episodes : p.scenes;
        const item = itemId ? list.find((x) => x.id === itemId) : null;
        if (itemId) check(item, kind === "episodes" ? "Эпизод не найден." : "Сцена не найдена.", 404);
        if (req.method === "POST" && path !== "/api/move") {
          check(list.length < 500, "Слишком много элементов структуры.");
          const title = typeof b.title === "string" && b.title.trim()
            ? textValue(b.title, 200).trim()
            : `${kind === "episodes" ? "Эпизод" : "Сцена"} ${list.length + 1}`;
          backup(p);
          if (kind === "episodes") p.episodes.push({ id: id(), title });
          else {
            const episode = b.episodeId ? p.episodes.find((e) => e.id === b.episodeId) : p.episodes.at(-1);
            check(episode, "Эпизод не найден.", 404);
            p.scenes.push({ id: id(), episodeId: episode.id, title, fromScript: false });
          }
        } else if (req.method === "PATCH") {
          const title = "title" in b ? textValue(b.title, 200).trim() : item.title;
          check(title, kind === "episodes" ? "Введите название эпизода." : "Введите название сцены.");
          if (b.episodeId) check(kind === "scenes" && p.episodes.some((e) => e.id === b.episodeId), "Эпизод не найден.", 404);
          backup(p);
          if (title !== item.title) {
            if (item.fromScript) {  // the heading in the script is the same scene: rename it there too
              const next = renameHeading(p.script, item.title, title);
              if (next !== null) p.script = next;
              else item.fromScript = false;
            }
            item.title = title;
          }
          if (b.episodeId) item.episodeId = b.episodeId;
        } else if (req.method === "DELETE") {
          check(!item.fromScript, "Это заголовок из сценария. Уберите его в тексте сценария.");
          if (kind === "episodes") {
            check(p.episodes.length > 1, "В фильме должен остаться хотя бы один эпизод.");
            check(!p.scenes.some((sc) => sc.episodeId === item.id), "В эпизоде есть сцены. Сначала перенесите или уберите их.");
            backup(p);
            p.episodes = p.episodes.filter((e) => e !== item);
          } else {
            check(!p.shots.some((s) => s.sceneId === item.id), "В сцене есть шоты. Сначала перенесите или уберите их.");
            backup(p);
            p.scenes = p.scenes.filter((sc) => sc !== item);
          }
        } else if (path === "/api/move") {
          check(["shot", "scene", "episode"].includes(b.kind) && typeof b.id === "string", "Нечего переместить.");
          backup(p);
          if (!moveItem(p, b.kind, b.id, Number(b.direction))) return send(res, { ok: false });
        } else check(false, "Неизвестный запрос.", 404);
        p.revision++;
        relocateShotAssets(p);
        save();
        try { writeProjectFolder(p); }
        catch (e) { process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`); }
        return send(res, { ok: true });
      }
      if (req.method === "PATCH" && path.startsWith("/api/assets/")) {
        const b = await readJSON(req), p = getProject(b.projectId), a = getAsset(path.split("/")[3], p.id);
        const name = "name" in b ? textValue(b.name, 200).trim() : a.name;
        check(name, "Введите название материала.");
        const collection = b.collection || a.collection || "library";
        check(["library", "archive"].includes(collection), "Выберите библиотеку или архив.");
        if (collection === "archive") {
          const used = p.timeline.some((c) => c.assetId === a.id) || p.musicId === a.id || p.cards.some((c) => c.assetIds?.includes(a.id)) || p.shots.some((s) => s.referenceId === a.id || s.endReferenceId === a.id || s.selectedVideoId === a.id || s.referenceIds?.includes(a.id));
          check(!used, "Сначала уберите материал из шотов, карточек и монтажа.");
        }
        const previous = { name: a.name, collection: a.collection, folder: a.folder, file: a.file };
        a.name = name;
        a.collection = collection;
        try {
          placeAsset(a);
          save();
        } catch (e) {
          const moved = file(a);
          Object.assign(a, previous);
          const original = file(a);
          if (moved !== original && existsSync(moved) && !existsSync(original)) {
            mkdirSync(dirname(original), { recursive: true, mode: 0o700 });
            renameSync(moved, original);
          }
          throw e;
        }
        try { writeProjectFolder(p); }
        catch (e) { process.emitWarning(`Не удалось обновить папку фильма: ${e.message}`); }
        return send(res, a);
      }
      if(req.method === "POST" && path === "/api/quote") {
        const b=await readJSON(req);return send(res,await quote(b,getProject(b.projectId)));
      }
      if(req.method === "GET" && path.startsWith("/api/job/")) {
        const j=data.jobs.find(j=>j.id===path.split("/")[3]);check(j,"Задание не найдено.",404);return send(res,j);
      }
      if(req.method === "POST" && path === "/api/cards") {
        const b=await readJSON(req),p=getProject(b.projectId);
        check(b.revision === p.revision,"Библиотека изменена в другом окне.",409);
        check(p.cards.length<200,"Не более 200 карточек.");
        const c={id:id(),title:textValue(b.title,200),category:b.category || "character",description:textValue(b.description || "",10000),assetIds:[]};
        check(c.title.trim() && ["character","location","style","object"].includes(c.category),"Введите название и тип карточки.");
        backup(p);p.cards.push(c);p.revision++;save();return send(res,c,201);
      }
      if(req.method === "PATCH" && path.startsWith("/api/cards/")) {
        const b=await readJSON(req),p=getProject(b.projectId),c=p.cards.find(c=>c.id===path.split("/")[3]);
        check(c,"Карточка не найдена.",404);check(b.revision===p.revision,"Карточка изменена в другом окне.",409);
        const fields={};
        for(const k of ["title","description"]) if(k in b) fields[k]=textValue(b[k],k==="title"?200:10000);
        if("assetIds" in b) {check(Array.isArray(b.assetIds) && b.assetIds.length<=50,"Не более 50 изображений.");for(const a of b.assetIds) check(libraryAsset(a,p.id).kind==="image","Выберите изображение.");fields.assetIds=[...new Set(b.assetIds)];}
        backup(p);Object.assign(c,fields);p.revision++;save();return send(res,c);
      }
      if(req.method === "DELETE" && path.startsWith("/api/cards/")) {
        const b=await readJSON(req),p=getProject(b.projectId);check(b.revision===p.revision,"Библиотека изменена.",409);
        backup(p);p.cards=p.cards.filter(c=>c.id!==path.split("/")[3]);p.revision++;save();return send(res,{ok:true});
      }
      if (req.method === "POST" && path === "/api/jobs") {
        const b = await readJSON(req),
          p = getProject(b.projectId);
        check(
          ["image", "video", "assistant"].includes(b.kind),
          "Неизвестное задание.",
        );
        const m=b.kind === "assistant"?null:modelFor(b,data.settings);
        if(m) validateModelInput(m,b);
        const provider = m?.provider || b.provider;
        check(
          b.kind === "video"
            ? ["seedance", "kling", "openrouter"].includes(provider)
            : ["openai", "local", "deepseek", "anthropic", "sonnet"].includes(provider),
          "Неизвестный провайдер.",
        );
        const prompt = textValue(b.prompt, 32000);
        check(prompt.trim(), "Введите промпт.");
        if (b.requestId) {
          check(
            typeof b.requestId === "string" &&
              /^[a-f0-9-]{36}$/.test(b.requestId),
            "Неверный идентификатор запроса.",
          );
          const existing = data.jobs.find(
            (j) => j.projectId === p.id && j.requestId === b.requestId,
          );
          if (existing) {
            check(
              JSON.stringify([existing.prompt,existing.kind,existing.provider,existing.modelId,existing.referenceId,existing.referenceIds || [],existing.endReferenceId,existing.duration,existing.resolution,!!existing.sound,existing.quality]) ===
                JSON.stringify([prompt,b.kind,provider,m?.id,b.referenceId || null,b.referenceIds || [],b.endReferenceId || null,b.duration,b.resolution || (m?.resolutions?.length ? "720p" : undefined),!!b.sound,b.kind === "image" ? b.quality || "medium" : undefined]),
              "Идентификатор уже использован для другого задания.",
            );
            return send(res, existing);
          }
        }
        let price={amount:0,source:"Подписка CLI"};
        if (!["local","sonnet"].includes(provider)) {
          credential(provider);price=await quote(b,p);
          b.estimate=Math.max(Number(b.estimate) || 0,price.amount);
          validateEstimate(b.estimate,p,data.jobs);
        }
        const refs=b.referenceIds || [];
        check(Array.isArray(refs) && refs.length<=30,"Неверный набор изображений.");
        for(const a of [...refs,b.referenceId,b.endReferenceId].filter(Boolean)) {
          const ref=libraryAsset(a,p.id);check(ref.kind === "image" && ref.bytes <= 30*1024*1024,"Референс должен быть изображением до 30 МБ.");
        }
        if(b.kind === "assistant" && refs.length && ["deepseek","local","sonnet"].includes(provider)) check(false,"Этот помощник принимает только текст.");
        if (b.kind !== "assistant")
          check(
            p.shots.some((s) => s.id === b.shotId),
            "Выберите шот.",
          );
        check(
          data.jobs.filter((j) =>
            ["submitting", "waiting", "running", "downloading"].includes(
              j.status,
            ),
          ).length < 4,
          "Уже выполняются четыре задания. Дождитесь завершения.",
        );
        const job = {
          id: id(),
          requestId: b.requestId || null,
          projectId: p.id,
          shotId: b.kind === "assistant" ? null : b.shotId,
          kind: b.kind,
          provider,
          prompt,
          estimate: ["local","sonnet"].includes(provider) ? 0 : b.estimate,
          price,
          referenceIds:refs,
          endReferenceId:b.endReferenceId || null,
          modelId:m?.id,
          resolution:b.resolution || (m?.resolutions?.length ? "720p" : undefined),
          referenceId: b.referenceId || null,
          status: "queued",
          createdAt: new Date().toISOString(),
          model: m?.api || (provider === "local"?data.settings.codexModel:provider === "sonnet"?"sonnet":provider === "deepseek"?data.settings.deepseekModel:provider === "anthropic"?data.settings.anthropicModel:data.settings.textModel),
          ratio: p.ratio,
        };
        if (job.referenceId) {
          check(
            libraryAsset(job.referenceId, p.id).kind === "image",
            "Выберите изображение.",
          );
          check(
            libraryAsset(job.referenceId, p.id).bytes <= 30 * 1024 * 1024,
            "Референс больше 30 МБ.",
          );
        }
        if (b.kind === "video") {
          job.duration = finite(b.duration, 3, 30, "длительность");
          check(Number.isInteger(job.duration), "Нужна целая длительность.");
          if (provider === "kling")
            check(
              [5, 10].includes(job.duration),
              "Первая версия адаптера Kling поддерживает 5 или 10 секунд.",
            );
          job.sound = !!b.sound;
          job.service = "modelark";
          reference(job, provider === "kling");
          if(job.endReferenceId) reference(job,false,job.endReferenceId);
        }
        if (b.kind === "image") {
          const custom = /^gpt-image-(2|2\.5)/.test(job.model);
          job.size =
            p.ratio === "9:16"
              ? custom
                ? "864x1536"
                : "1024x1536"
              : p.ratio === "1:1"
                ? "1024x1024"
                : custom
                  ? "1536x864"
                  : "1536x1024";
          job.quality = b.quality || "medium";
          check(
            ["low", "medium", "high"].includes(job.quality),
            "Неверное качество.",
          );
        }
        data.jobs.push(job);
        save();
        send(res, job, 201);
        void run(job);
        return;
      }
      if (req.method === "POST" && path === "/api/poll") {
        const b = await readJSON(req),
          job = data.jobs.find((j) => j.id === b.id);
        check(job, "Задание не найден.", 404);
        check(
          ["waiting", "download_failed", "uncertain"].includes(job.status) &&
            job.kind === "video",
          "Задание нельзя проверить.",
        );
        if (b.remoteId) {
          check(!job.remoteId, "ID уже сохранён.");
          job.remoteId = textValue(b.remoteId, 200);
          check(/^[a-zA-Z0-9_-]+$/.test(job.remoteId), "Неверный ID.");
          job.status = "waiting";
          save();
        }
        check(
          job.remoteId || job.resultUrl,
          "ID неизвестен. Укажите ID из кабинета провайдера.",
        );
        void poll(job);
        return send(res, { ok: true });
      }
      if (req.method === "POST" && path === "/api/render") {
        const b = await readJSON(req),
          p = getProject(b.projectId);
        check(!exporting, "Другой монтаж уже экспортируется.");
        check(
          existsSync(ffmpeg),
          "FFmpeg не установлен. Выполните npm install.",
        );
        const timeline = validateTimeline(
          p.timeline,
          data.assets.filter((a) => a.projectId === p.id && (a.collection || "library") === "library"),
        );
        check(timeline.length, "Добавьте клипы в монтаж.");
        const job = {
          id: id(),
          projectId: p.id,
          kind: "export",
          provider: "local",
          status: "queued",
          timeline: structuredClone(timeline),
          ratio: p.ratio,
          musicId: p.musicId,
          musicVolume: p.musicVolume,
          estimate: 0,
          createdAt: new Date().toISOString(),
          progress: 0,
        };
        data.jobs.push(job);
        save();
        send(res, job, 201);
        void render(job);
        return;
      }
      throw Object.assign(new Error("Маршрут не найден."), { status: 404 });
    } catch (e) {
      if (!res.headersSent)
        send(res, { error: sanitize(e.message) }, e.status || 500);
      else res.destroy();
    }
  });
  server.requestTimeout = 600000;
  return {
    server,
    data,
    root,
    close: () => {
      clearInterval(ticker);
      server.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const studio = createStudio({
    root: process.env.KINO_DATA_DIR || join(appDir, ".local"),
  });
  const port = Number(process.env.KINO_PORT || 4317);
  studio.server.listen(port, "127.0.0.1", () =>
    console.log(
      `KAZAK studio: http://127.0.0.1:${studio.server.address().port}`,
    ),
  );
  studio.server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE"
        ? `Порт ${port} занят. Откройте уже запущенное приложение или задайте KINO_PORT.`
        : e.message,
    );
    process.exitCode = 1;
    studio.close();
  });
}
