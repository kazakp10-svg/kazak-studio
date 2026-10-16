import { createHmac, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";

export const id = () => randomUUID();
export const defaults = {
  textModel: "gpt-6-sol",
  codexModel: "gpt-5.5",
  deepseekModel: "deepseek-flash",
  anthropicModel: "claude-sonnet-4-6",
  imageReserve: 0.25,
  assistantReserve: 0.15,
  klingSecondRate: 0.2,
  seedance25TokenRate: 0,
  imageModel: "gpt-image-2.5-sunburst",
  seedanceModel: "dreamina-seedance-2-0-260128",
  klingModel: "kling-v3",
};
export function check(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
export function codexError(message) {
  const line = String(message)
    .split("\n")
    .findLast((s) => s.startsWith("ERROR: "));
  if (line) {
    try {
      return JSON.parse(line.slice(7)).error?.message || line.slice(7);
    } catch {
      return line.slice(7);
    }
  }
  return String(message).slice(-1000);
}
export function textValue(value, max = 100000) {
  check(
    typeof value === "string" && value.length <= max,
    "Некорректный текст или превышен лимит.",
  );
  return value;
}
export function finite(value, min, max, label) {
  check(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max,
    `Некорректное значение: ${label}.`,
  );
  return value;
}
export function atomicJSON(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(temp, 0o600);
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
export function loadStore(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const dir of ["media", "exports", "work", "backups"])
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const path = join(root, "studio.json");
  const data = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { projects: [], assets: [], jobs: [], settings: { ...defaults } };
  check(
    Array.isArray(data.projects) &&
      Array.isArray(data.assets) &&
      Array.isArray(data.jobs),
    "Файл проекта повреждён. Сохраните его копию перед восстановлением.",
    500,
  );
  return { data, save: () => atomicJSON(path, data) };
}
export function projectFields(input) {
  const out = {};
  for (const key of ["title", "brief", "script", "bible"])
    if (key in input)
      out[key] = textValue(input[key], key === "title" ? 200 : 100000);
  if ("ratio" in input) {
    check(["16:9", "9:16", "1:1"].includes(input.ratio), "Неверный формат.");
    out.ratio = input.ratio;
  }
  if ("budget" in input)
    out.budget = input.budget === null ? null : finite(input.budget, 0, 100000, "бюджет");
  return out;
}
export function shotFields(input) {
  const out = {};
  for (const key of [
    "title",
    "description",
    "imagePrompt",
    "videoPrompt",
    "notes",
  ])
    if (key in input)
      out[key] = textValue(input[key], key === "title" ? 200 : 10000);
  if ("sceneId" in input) out.sceneId = textValue(input.sceneId, 100);
  if ("duration" in input)
    out.duration = finite(input.duration, 3, 30, "длительность");
  if ("status" in input) {
    check(
      ["planned", "reference", "generated", "approved"].includes(input.status),
      "Неверный статус.",
    );
    out.status = input.status;
  }
  if ("referenceIds" in input) {
    check(Array.isArray(input.referenceIds) && input.referenceIds.length <= 30 && input.referenceIds.every(x => typeof x === "string" && x.length <= 100), "Неверный набор референсов.");
    out.referenceIds = [...new Set(input.referenceIds)];
  }
  if ("selectedVideoId" in input) out.selectedVideoId = input.selectedVideoId === null ? null : textValue(input.selectedVideoId,100);
  if ("endReferenceId" in input) out.endReferenceId = input.endReferenceId === null ? null : textValue(input.endReferenceId,100);
  if ("modelId" in input) out.modelId = textValue(input.modelId,100);
  if ("referenceId" in input)
    out.referenceId =
      input.referenceId === null ? null : textValue(input.referenceId, 100);
  return out;
}
export function reservedCost(jobs, projectId) {
  return jobs
    .filter((j) => j.projectId === projectId && j.provider !== "local")
    .reduce((s, j) => s + (j.estimate || 0), 0);
}
export function validateEstimate(value, project, jobs) {
  finite(value, 0.001, 10000, "оценка цены в USD");
  if (project.budget == null) return;
  check(
    reservedCost(jobs, project.id) + value <= project.budget + 0.000001,
    "Оценка превышает бюджет проекта. Измените бюджет или оценку.",
  );
}
export function klingToken(keys, now = Math.floor(Date.now() / 1000)) {
  if (keys.klingKey) return keys.klingKey;
  check(
    keys.klingAccess && keys.klingSecret,
    "Добавьте ключ Kling или пару Access Key / Secret Key в подключениях.",
  );
  const a = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  );
  const b = Buffer.from(
    JSON.stringify({ iss: keys.klingAccess, exp: now + 1800, nbf: now - 5 }),
  ).toString("base64url");
  return `${a}.${b}.${createHmac("sha256", keys.klingSecret).update(`${a}.${b}`).digest("base64url")}`;
}
export function seedanceBody(job, reference, endReference, references = []) {
  const content = [{ type: "text", text: job.prompt }];
  if (reference)
    content.push({
      type: "image_url",
      image_url: { url: reference },
      role: "first_frame",
    });
  if (endReference) content.push({type:"image_url", image_url:{url:endReference},role:"last_frame"});
  for (const url of references) content.push({type:"image_url",image_url:{url},role:"reference_image"});
  return {
    model: job.model,
    content,
    duration: job.duration,
    ratio: job.ratio,
    resolution: job.resolution || "720p",
    generate_audio: job.sound,
    watermark: false,
  };
}
export function klingBody(job, reference) {
  const body = {
    model_name: job.model,
    prompt: job.prompt,
    duration: String(job.duration),
    mode: "pro",
    sound: job.sound ? "on" : "off",
    external_task_id: job.id,
  };
  if (reference) body.image = reference;
  else body.aspect_ratio = job.ratio;
  return body;
}
export function parseVideo(provider, result) {
  if (provider === "seedance")
    return {
      state: result.status,
      url: result.content?.video_url,
      error: result.error?.message,
      usage: result.usage,
    };
  check(
    result.code === 0 || result.code === undefined,
    result.message || "Ошибка Kling API.",
    502,
  );
  const d = result.data || {};
  return {
    state:
      { succeed: "succeeded", submitted: "queued", processing: "running" }[
        d.task_status
      ] || d.task_status,
    url: d.task_result?.videos?.[0]?.url,
    error: d.task_status_msg,
    usage: result.usage,
  };
}
export function validateTimeline(timeline, assets) {
  check(
    Array.isArray(timeline) && timeline.length <= 200,
    "В монтаже должно быть не более 200 клипов.",
  );
  return timeline.map((c) => {
    const asset = assets.find((a) => a.id === c.assetId);
    check(asset?.kind === "video", "Выберите видео из медиатеки.");
    const start = finite(c.start, 0, asset.duration, "начало обрезки");
    const end = finite(
      c.end,
      start + 0.04,
      asset.duration + 0.02,
      "конец обрезки",
    );
    return {
      id: typeof c.id === "string" ? textValue(c.id, 100) : id(),
      assetId: asset.id,
      start,
      end: Math.min(end, asset.duration),
      muted: !!c.muted,
    };
  });
}
export function isPublicIP(address) {
  if (address.includes(":"))
    return (
      !/^(::|fc|fd|fe[89ab]|ff|2001:db8)/i.test(address) &&
      !address.includes(".")
    );
  const [a, b] = address.split(".").map(Number);
  return (
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || b === 2)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
    !(a === 203 && b === 0)
  );
}
export function pinnedLookup(address) {
  return (_hostname, options, callback) =>
    options?.all
      ? callback(null, [address])
      : callback(null, address.address, address.family);
}
export function validMediaHeader(buffer, extension) {
  const ascii = (start, end) => buffer.subarray(start, end).toString("ascii");
  if (extension === ".png")
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if ([".jpg", ".jpeg"].includes(extension))
    return buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (extension === ".webp")
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if ([".mp4", ".mov", ".m4a"].includes(extension))
    return ["ftyp", "moov", "mdat", "wide", "free"].includes(ascii(4, 8));
  if (extension === ".webm")
    return buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (extension === ".wav")
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  if (extension === ".mp3")
    return (
      ascii(0, 3) === "ID3" || (buffer[0] === 255 && (buffer[1] & 224) === 224)
    );
  return false;
}
