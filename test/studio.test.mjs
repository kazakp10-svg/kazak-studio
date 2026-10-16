import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { createStudio, downloadPublic } from "../server.mjs";
import {
  validateEstimate,
  projectFields,
  validateTimeline,
  klingToken,
  seedanceBody,
  klingBody,
  parseVideo,
  isPublicIP,
  pinnedLookup,
  validMediaHeader,
  codexError,
} from "../lib.mjs";

test("pinned DNS lookup returns the shape requested by Node", () => {
  const answer = { address: "93.184.216.34", family: 4 };
  let actual;
  pinnedLookup(answer)("example.com", { all: true }, (...args) => (actual = args));
  assert.deepEqual(actual, [null, [answer]]);
  pinnedLookup(answer)("example.com", {}, (...args) => (actual = args));
  assert.deepEqual(actual, [null, answer.address, answer.family]);
});

test("validation, budgets, provider payloads, and private-network boundaries", () => {
  assert.equal(
    codexError(
      'startup warning\nERROR: {"error":{"message":"model unavailable"}}',
    ),
    "model unavailable",
  );
  assert.equal(codexError("spawn codex ENOENT"), "spawn codex ENOENT");
  assert.throws(
    () =>
      validateEstimate(3, { id: "p", budget: 5 }, [
        { projectId: "p", provider: "kling", estimate: 3, status: "uncertain" },
      ]),
    /бюджет/,
  );
  assert.throws(() => validateEstimate(NaN, { id: "p", budget: 5 }, []));
  assert.doesNotThrow(() =>
    validateEstimate(3, { id: "p", budget: null }, [
      { projectId: "p", provider: "kling", estimate: 100 },
    ]),
  );
  assert.equal(projectFields({ budget: null }).budget, null);
  assert.throws(() =>
    validateTimeline(
      [{ assetId: "a", start: 2, end: 1 }],
      [{ id: "a", kind: "video", duration: 5 }],
    ),
  );
  assert.throws(() =>
    validateTimeline([{ assetId: "x", start: 0, end: 1 }], []),
  );
  assert.equal(klingToken({ klingKey: "api-key" }), "api-key");
  const token = klingToken(
      { klingAccess: "access", klingSecret: "secret" },
      1000,
    ),
    payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  assert.equal(payload.iss, "access");
  assert.equal(payload.exp, 2800);
  assert.equal(payload.nbf, 995);
  const j = {
    id: "uuid",
    model: "kling-v3",
    prompt: "test",
    duration: 5,
    ratio: "16:9",
    sound: true,
  };
  assert.equal(klingBody(j, "raw-base64").image, "raw-base64");
  assert.equal(klingBody(j).aspect_ratio, "16:9");
  assert.equal(
    seedanceBody(j, "data:image/png;base64,abc").content[1].role,
    "first_frame",
  );
  assert.equal(
    parseVideo("kling", {
      code: 0,
      data: {
        task_status: "succeed",
        task_result: { videos: [{ url: "https://cdn.example/video.mp4" }] },
      },
    }).state,
    "succeeded",
  );
  for (const a of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "172.20.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
  ])
    assert.equal(isPublicIP(a), false, a);
  assert.equal(isPublicIP("8.8.8.8"), true);
  assert.equal(
    validMediaHeader(Buffer.from("#EXTM3U\nhttp://127.0.0.1/secret"), ".mp4"),
    false,
  );
});

test("local film workflow, API contracts, real export, archive and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "kazak-test-"));
  const calls = [];
  const red = join(root, "red.mp4"),
    blue = join(root, "blue.mp4"),
    tone = join(root, "music.wav"),
    image = join(root, "ref.png");
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=640x360:r=24:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    red,
  ]);
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=640x360:r=24:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    blue,
  ]);
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=3",
    tone,
  ]);
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=640x360",
    "-frames:v",
    "1",
    image,
  ]);
  let openedFolder;
  const studio = createStudio({
    root,
    keys: {
      openaiKey: "test-openai",
      seedanceKey: "test-seedance",
      klingKey: "test-kling",
    },
    request: async (url, key, body) => {
      calls.push({ url, key, body });
      if (url.endsWith("/models")) return { data: [{ id: "gpt-6-sol" }] };
      if (url.endsWith("/responses"))
        return {
          output: [
            {
              content: [
                { type: "output_text", text: "СЦЕНА 1. Проверка сценария." },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      if (url.includes("/images/"))
        return {
          data: [{ b64_json: readFileSync(image).toString("base64") }],
          usage: { total_tokens: 42 },
        };
      if (url.includes("/contents/generations/tasks"))
        return body
          ? { id: "seed-task" }
          : {
              status: "succeeded",
              content: { video_url: "https://cdn.example/seed.mp4" },
              usage: { completion_tokens: 100 },
            };
      if (url.includes("/v1/videos/"))
        return body
          ? { code: 0, data: { task_id: "kling-task" } }
          : {
              code: 0,
              data: {
                task_status: "succeed",
                task_result: {
                  videos: [{ url: "https://cdn.example/kling.mp4" }],
                },
              },
            };
      throw new Error("Unexpected outbound request");
    },
    download: async (_url, path) => copyFileSync(red, path),
    revealFolder: async (path) => { openedFolder = path; },
  });
  await new Promise((r) => studio.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  async function api(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(base + path, {
      method,
      headers: {
        "X-Studio-Request": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  async function waitJob(id) {
    for (let i = 0; i < 200; i++) {
      const j = studio.data.jobs.find((j) => j.id === id);
      if (["succeeded", "failed", "uncertain", "waiting"].includes(j.status))
        return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Job timed out");
  }
  try {
    const state = await api("/api/state");
    assert.equal(state.appId, "kazak-studio");
    assert.ok(!JSON.stringify(state).includes("test-openai"));
    const favicon = await fetch(base + "/favicon.svg");
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await favicon.text(), /<svg/);
    assert.equal(
      (
        await fetch(base + "/api/state", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/api/projects", { method: "POST", body: "{}" }))
        .status,
      403,
    );
    assert.equal((await fetch(base + "/.local/studio.json")).status, 404);
    await assert.rejects(
      () => downloadPublic("https://127.0.0.1/test.mp4", join(root, "bad.mp4")),
      /локальной/,
    );
    const project = await api("/api/projects", { title: "Тестовый фильм" }),
      projectId = project.id;
    assert.equal(project.budget, null);
    assert.ok(existsSync(join(root, project.folder, "project.json")));
    await api("/api/project-folder", { projectId });
    assert.equal(openedFolder, join(root, project.folder));
    const s = await api("/api/shots", { projectId, title: "Первый кадр" });
    const frameFolder = join(
      root, project.folder, "02-Изображения", "Эпизоды", "Эпизод 1",
      "Сцены", "Сцена 1", "Шоты", "Первый кадр", "Кадры",
    );
    assert.ok(existsSync(frameFolder));
    assert.ok(existsSync(join(frameFolder, "Начальный")));
    assert.ok(existsSync(join(frameFolder, "Конечный")));
    assert.ok(existsSync(join(frameFolder, "Референсы")));
    assert.equal(
      JSON.parse(readFileSync(join(root, project.folder, "project.json"), "utf8")).project.shots[0].title,
      "Первый кадр",
    );
    let current = studio.data.projects[0];
    await api(`/api/projects/${projectId}`, { revision: current.revision, budget: 5 }, "PATCH");
    current = studio.data.projects[0];
    await api(`/api/projects/${projectId}`, { revision: current.revision, budget: null }, "PATCH");
    current = studio.data.projects[0];
    assert.equal(current.budget, null);
    await api(
      `/api/projects/${projectId}`,
      { revision: current.revision, script: "Исходный сценарий" },
      "PATCH",
    );
    current = studio.data.projects[0];
    await api(
      `/api/projects/${projectId}`,
      { revision: current.revision, script: "Новая версия" },
      "PATCH",
    );
    const conflict = await fetch(`${base}/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
      body: JSON.stringify({ revision: 0, script: "lost" }),
    });
    assert.equal(conflict.status, 409);
    await api("/api/restore", { projectId, revision: current.revision });
    assert.equal(current.script, "Исходный сценарий");
    async function upload(path, name, targetShot = s.id) {
      const query = new URLSearchParams({
        projectId,
        name,
        ...(targetShot ? { shotId: targetShot } : {}),
      });
      const response = await fetch(
        `${base}/api/upload?${query}`,
        {
          method: "POST",
          headers: { "X-Studio-Request": "1" },
          body: readFileSync(path),
        },
      );
      const a = await response.json();
      assert.ok(response.ok, JSON.stringify(a));
      return a;
    }
    const a = await upload(red, "Красный.mp4"),
      b = await upload(blue, "Синий.mp4"),
      music = await upload(tone, "Музыка.wav"),
      ref = await upload(image, "Референс.png");
    assert.equal(a.hasAudio, false);
    assert.equal(b.hasAudio, true);
    assert.equal(a.collection, "library");
    assert.ok(a.folder.startsWith(`${project.folder}/03-Видео/`));
    assert.ok(existsSync(join(root, a.folder, a.file)));
    assert.ok(existsSync(join(root, "media", a.thumbnail)));
    const range = await fetch(`${base}/media/${a.id}`, {
      headers: { Range: "bytes=0-9" },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 10);
    const assistant = await api("/api/jobs", {
      projectId,
      kind: "assistant",
      provider: "openai",
      prompt: "Уточни сцену",
      estimate: 0.02,
    });
    assert.equal((await waitJob(assistant.id)).status, "succeeded");
    assert.equal(current.messages.length, 2);
    assert.equal(current.script, "Исходный сценарий");
    const requestId = randomUUID(),
      generation = {
        requestId,
        projectId,
        shotId: s.id,
        kind: "image",
        prompt: "Кино",
        estimate: 0.1,
      };
    const gen = await api("/api/jobs", generation);
    assert.equal((await waitJob(gen.id)).status, "succeeded");
    const generatedAssetId = studio.data.jobs.find((j) => j.id === gen.id).assetId;
    let generatedAsset = studio.data.assets.find((x) => x.id === generatedAssetId);
    assert.equal(generatedAsset.collection, "review");
    assert.ok(generatedAsset.folder.includes("80-Проверка/Изображения"));
    let savedAsset = await api(`/api/assets/${generatedAssetId}`, {
      projectId, name: "Лучший вариант", collection: "library",
    }, "PATCH");
    assert.ok(savedAsset.folder.includes("02-Изображения/Эпизоды/Эпизод 1/Сцены/Сцена 1/Шоты/Первый кадр/Кадры/Референсы"));
    assert.ok(existsSync(join(root, savedAsset.folder, savedAsset.file)));
    assert.match(savedAsset.file, /Лучший вариант/);
    current = studio.data.projects[0];
    await api(`/api/shots/${s.id}`, {
      projectId, revision: current.revision, title: "Шот 01",
    }, "PATCH");
    savedAsset = studio.data.assets.find((a) => a.id === generatedAssetId);
    assert.ok(savedAsset.folder.endsWith("/Шоты/Шот 01/Кадры/Референсы"));
    assert.ok(existsSync(join(root, savedAsset.folder, savedAsset.file)));
    current = studio.data.projects[0];
    await api(`/api/shots/${s.id}`, {
      projectId, revision: current.revision, referenceId: generatedAssetId,
    }, "PATCH");
    savedAsset = studio.data.assets.find((a) => a.id === generatedAssetId);
    assert.ok(savedAsset.folder.endsWith("/Шоты/Шот 01/Кадры/Начальный"));
    const blockedArchive = await fetch(`${base}/api/assets/${generatedAssetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
      body: JSON.stringify({ projectId, collection: "archive" }),
    });
    assert.equal(blockedArchive.status, 400);
    current = studio.data.projects[0];
    await api(`/api/shots/${s.id}`, {
      projectId, revision: current.revision, referenceId: null,
      endReferenceId: generatedAssetId,
    }, "PATCH");
    savedAsset = studio.data.assets.find((a) => a.id === generatedAssetId);
    assert.ok(savedAsset.folder.endsWith("/Шоты/Шот 01/Кадры/Конечный"));
    current = studio.data.projects[0];
    await api(`/api/shots/${s.id}`, {
      projectId, revision: current.revision, endReferenceId: null,
    }, "PATCH");
    savedAsset = studio.data.assets.find((a) => a.id === generatedAssetId);
    assert.ok(savedAsset.folder.endsWith("/Шоты/Шот 01/Кадры/Референсы"));
    savedAsset = await api(`/api/assets/${generatedAssetId}`, {
      projectId, collection: "archive",
    }, "PATCH");
    assert.ok(savedAsset.folder.includes("90-Архив/Изображения"));
    savedAsset = await api(`/api/assets/${generatedAssetId}`, {
      projectId, collection: "library",
    }, "PATCH");
    assert.equal(savedAsset.collection, "library");
    await api(`/api/assets/${generatedAssetId}`, { projectId, collection: "archive" }, "PATCH");
    const same = await api("/api/jobs", generation);
    assert.equal(same.id, gen.id);
    assert.equal(
      calls.filter((c) => c.url.endsWith("/images/generations")).length,
      1,
    );
    assert.equal(
      calls.find((c) => c.url.endsWith("/images/generations")).body.size,
      "1536x864",
    );
    const edit = await api("/api/jobs", {
      projectId,
      shotId: s.id,
      kind: "image",
      prompt: "Измени свет",
      referenceId: ref.id,
      estimate: 0.1,
    });
    assert.equal((await waitJob(edit.id)).status, "succeeded");
    assert.ok(
      calls.find((c) => c.url.endsWith("/edits")).body instanceof FormData,
    );
    for (const provider of ["seedance", "kling"]) {
      const j = await api("/api/jobs", {
        projectId,
        shotId: s.id,
        kind: "video",
        provider,
        prompt: "Camera moves",
        duration: 5,
        sound: true,
        referenceId: ref.id,
        estimate: 0.5,
      });
      assert.equal((await waitJob(j.id)).status, "waiting");
      await api("/api/poll", { id: j.id });
      await new Promise((r) => setTimeout(r, 1000));
      const completed = studio.data.jobs.find((x) => x.id === j.id);
      assert.equal(completed.status, "succeeded");
      let videoAsset = studio.data.assets.find((x) => x.id === completed.assetId);
      assert.equal(videoAsset.collection, "review");
      assert.ok(videoAsset.folder.includes("80-Проверка/Видео"));
      if (provider === "seedance") {
        videoAsset = await api(`/api/assets/${videoAsset.id}`, {
          projectId, name: "Выбранный дубль", collection: "library",
        }, "PATCH");
        assert.ok(videoAsset.folder.includes("03-Видео/Эпизоды/"));
        assert.ok(videoAsset.folder.endsWith("/Шоты/Шот 01/Видео"));
        assert.ok(existsSync(join(root, videoAsset.folder, videoAsset.file)));
        videoAsset = await api(`/api/assets/${videoAsset.id}`, {
          projectId, collection: "archive",
        }, "PATCH");
        assert.ok(videoAsset.folder.includes("90-Архив/Видео"));
        assert.ok(existsSync(join(root, videoAsset.folder, videoAsset.file)));
      }
    }
    await api(
      `/api/projects/${projectId}`,
      {
        revision: current.revision,
        timeline: [
          { id: "first", assetId: a.id, start: 0.25, end: 1.25, muted: true },
          { id: "second", assetId: b.id, start: 0.5, end: 2, muted: false },
        ],
        musicId: music.id,
        musicVolume: 0.2,
      },
      "PATCH",
    );
    await api("/api/split", {
      projectId,
      revision: current.revision,
      position: 0.5,
    });
    assert.equal(current.timeline.length, 3);
    assert.equal(
      current.timeline.reduce((n, c) => n + c.end - c.start, 0),
      2.5,
    );
    const output = await api("/api/render", { projectId });
    const renderJob = await waitJob(output.id);
    assert.equal(renderJob.status, "succeeded", JSON.stringify(renderJob));
    const outAsset = studio.data.assets.find(
        (a) => a.id === output.assetId || a.jobId === output.id,
      ),
      path = join(root, outAsset.folder, outAsset.file);
    const meta = JSON.parse(
      execFileSync(
        ffprobe.path,
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        { encoding: "utf8" },
      ),
    );
    assert.equal(meta.streams[0].width, 1920);
    assert.equal(meta.streams[0].height, 1080);
    assert.equal(meta.streams[0].r_frame_rate, "24/1");
    assert.ok(meta.streams.some((s) => s.codec_type === "audio"));
    assert.ok(Math.abs(Number(meta.format.duration) - 2.5) < 0.2);
    const pixel = (t) =>
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-ss",
        String(t),
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        "scale=1:1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ]);
    const start = pixel(0.25),
      end = pixel(1.5);
    assert.ok(start[0] > start[2] + 100);
    assert.ok(end[2] > end[0] + 100);
    const audio = execFileSync(ffmpeg, [
      "-v",
      "error",
      "-i",
      path,
      "-t",
      "0.3",
      "-vn",
      "-ac",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ]);
    let energy = 0;
    for (let i = 0; i < audio.length; i += 2)
      energy += audio.readInt16LE(i) ** 2;
    assert.ok(
      energy > 1000000,
      "Music must be audible in the muted first clip",
    );
    const sharedImage = await upload(image, "Общий референс.png", null),
      secondShot = await api("/api/shots", {
        projectId,
        title: "Шот 02",
      });
    let freshProject = studio.data.projects.find((p) => p.id === projectId);
    await api(
      `/api/shots/${secondShot.id}`,
      {
        projectId,
        revision: freshProject.revision,
        referenceId: sharedImage.id,
      },
      "PATCH",
    );
    let shared = studio.data.assets.find((a) => a.id === sharedImage.id);
    assert.ok(shared.folder.endsWith("/Шоты/Шот 02/Кадры/Начальный"));
    const thirdShot = await api("/api/shots", {
      projectId,
      title: "Шот 03",
    });
    freshProject = studio.data.projects.find((p) => p.id === projectId);
    await api(
      `/api/shots/${thirdShot.id}`,
      {
        projectId,
        revision: freshProject.revision,
        endReferenceId: sharedImage.id,
      },
      "PATCH",
    );
    shared = studio.data.assets.find((a) => a.id === sharedImage.id);
    assert.ok(shared.folder.endsWith("/Шоты/Шот 03/Кадры/Конечный"));
    assert.ok(existsSync(join(root, shared.folder, shared.file)));
    assert.equal(
      studio.data.projects.find((p) => p.id === projectId).shots.find((s) => s.id === secondShot.id).referenceId,
      sharedImage.id,
    );
    const bundle = await api("/api/bundle", { projectId }),
      archive = Buffer.from(
        await (await fetch(base + bundle.url)).arrayBuffer(),
      );
    const imported = await fetch(base + "/api/import-project", {
      method: "POST",
      headers: { "X-Studio-Request": "1" },
      body: archive,
    });
    const importedProject = await imported.json();
    assert.equal(imported.status, 201, JSON.stringify(importedProject));
    assert.notEqual(importedProject.id, projectId);
    assert.equal(importedProject.timeline.length, 3);
    assert.equal(importedProject.script, current.script);
    assert.ok(importedProject.musicId);
    const importedImageJob = studio.data.jobs.find(
      (j) => j.projectId === importedProject.id && j.kind === "image" && j.prompt === "Кино",
    );
    assert.equal(studio.data.assets.find((a) => a.id === importedImageJob.assetId).collection, "archive");
    assert.ok(
      studio.data.jobs
        .filter((j) => j.projectId === importedProject.id)
        .every((j) => j.status === "archived"),
    );
    const archivedVideo = studio.data.jobs.find(
      (j) => j.projectId === importedProject.id && j.provider === "seedance",
    );
    assert.equal(archivedVideo.duration, 5);
    assert.equal(archivedVideo.sound, true);
    assert.deepEqual(archivedVideo.usage, { completion_tokens: 100 });
    assert.ok(
      studio.data.assets.some(
        (a) =>
          a.id === archivedVideo.referenceId &&
          a.projectId === importedProject.id,
      ),
    );
    const invalid = await fetch(
      `${base}/api/upload?${new URLSearchParams({ projectId, name: "playlist.mp4" })}`,
      {
        method: "POST",
        headers: { "X-Studio-Request": "1" },
        body: "#EXTM3U\nhttp://127.0.0.1/secret",
      },
    );
    assert.equal(invalid.status, 400);
    writeFileSync(join(root, "unwanted.txt"), "not a project");
    execFileSync("/usr/bin/tar", [
      "-czf",
      join(root, "invalid.kazak"),
      "-C",
      root,
      "unwanted.txt",
    ]);
    const count = studio.data.projects.length,
      badArchive = await fetch(base + "/api/import-project", {
        method: "POST",
        headers: { "X-Studio-Request": "1" },
        body: readFileSync(join(root, "invalid.kazak")),
      });
    assert.equal(badArchive.status, 400);
    assert.equal(studio.data.projects.length, count);
    const html = await (await fetch(base + "/")).text();
    assert.ok(html.includes("KAZAK studio"));
    const sentinel = {
      id: "interrupted",
      projectId,
      kind: "video",
      provider: "kling",
      status: "submitting",
      estimate: 0.5,
    };
    studio.data.jobs.push(sentinel);
    writeFileSync(join(root, "studio.json"), JSON.stringify(studio.data));
    studio.close();
    const restarted = createStudio({ root, keys: {} });
    assert.equal(restarted.data.projects.length, 2);
    assert.equal(
      restarted.data.jobs.find((j) => j.id === "interrupted").status,
      "uncertain",
    );
    restarted.close();
    assert.equal(
      calls.filter((c) => c.url.includes("/v1/videos/") && c.body).length,
      1,
      "Polling must not create paid duplicate tasks",
    );
  } finally {
    studio.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous provider failure is preserved without retries or secret leakage", async () => {
  const root = mkdtempSync(join(tmpdir(), "kazak-failure-"));
  let submissions = 0;
  const studio = createStudio({
    root,
    keys: { seedanceKey: "test-secret-value" },
    request: async () => {
      submissions++;
      throw new Error("Connection lost test-secret-value");
    },
  });
  await new Promise((r) => studio.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  try {
    const p = await post("/api/projects", { title: "Failure case" }),
      s = await post("/api/shots", { projectId: p.id }),
      requestId = randomUUID();
    const body = {
      projectId: p.id,
      shotId: s.id,
      kind: "video",
      provider: "seedance",
      prompt: "Test",
      duration: 5,
      estimate: 0.5,
      requestId,
    };
    const j = await post("/api/jobs", body);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(studio.data.jobs[0].status, "uncertain");
    assert.ok(!studio.data.jobs[0].error.includes("test-secret-value"));
    const repeated = await post("/api/jobs", body);
    assert.equal(j.id, repeated.id);
    assert.equal(submissions, 1);
    assert.equal(studio.data.jobs.length, 1);
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(state.estimatedSpend[p.id], state.jobs.find((job) => job.id === j.id).estimate);
  } finally {
    studio.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seedance 2.0 Mini supports references and quotes OpenRouter pricing", async () => {
  const root = mkdtempSync(join(tmpdir(), "kazak-mini-"));
  const studio = createStudio({ root, keys: {} });
  await new Promise((r) => studio.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  try {
    const project = await post("/api/projects", { title: "Mini quote" });
    const quote = await post("/api/quote", {
      projectId: project.id,
      kind: "video",
      provider: "openrouter",
      modelId: "seedance-2-mini-openrouter",
      prompt: "Кадр с вымышленным персонажем",
      duration: 5,
      resolution: "480p",
      sound: false,
      referenceIds: [randomUUID()],
    });
    assert.equal(quote.amount, 0.1774);
    assert.match(quote.source, /\$3\.50 за млн токенов/);
  } finally {
    studio.close();
    rmSync(root, { recursive: true, force: true });
  }
});
