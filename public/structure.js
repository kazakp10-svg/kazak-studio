// Film structure shared by the server and the browser:
// film -> episodes -> scenes -> shots. A shot is a video made from text, one frame or two
// (start and end); a frame is a single image; a take is one attempt at a shot.
// Scenes can be tied to scene headings in the script text, so the script and the
// storyboard talk about the same scenes.

export const DEFAULT_EPISODE = "Эпизод 1";
export const DEFAULT_SCENE = "Сцена 1";

export const norm = (t) => String(t || "").trim().replace(/\s+/g, " ").toUpperCase();

const SCENE_RE = /^[ \t]*((?:\d+[.)]?\s*)?(?:ИНТ|НАТ|INT|EXT|СЦЕНА|SCENE)(?=[\s.:/—-])[^\n]*)$/gim;
const EPISODE_RE = /^[ \t]*((?:ЭПИЗОД|СЕРИЯ|EPISODE)(?=[\s.:—-]|$)[^\n]*)$/gim;

/** Episode and scene headings of a script in text order. */
export function parseScript(text) {
  const out = [];
  for (const [kind, re] of [["scene", SCENE_RE], ["episode", EPISODE_RE]]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text || ""))) out.push({ kind, title: m[1].trim(), index: m.index + m[0].indexOf(m[1]) });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** [{episode, scenes:[{scene, shots}]}] in film order. Orphans are tolerated, never dropped. */
export function orderedStructure(p) {
  const episodes = p.episodes?.length ? p.episodes : [{ id: null, title: DEFAULT_EPISODE }];
  const scenes = p.scenes || [];
  const first = episodes[0];
  const groups = episodes.map((episode) => ({ episode, scenes: [] }));
  const bySceneId = new Map();
  for (const scene of scenes) {
    const group = groups.find((g) => g.episode.id === scene.episodeId) || groups[0];
    const entry = { scene, shots: [] };
    group.scenes.push(entry);
    bySceneId.set(scene.id, entry);
  }
  for (const shot of p.shots || []) {
    const entry = bySceneId.get(shot.sceneId) || groups.flatMap((g) => g.scenes)[0];
    if (entry) entry.shots.push(shot);
    else {  // shots without any scene: show them under a placeholder instead of hiding them
      let ghost = bySceneId.get("__none");
      if (!ghost) {
        ghost = { scene: { id: "__none", episodeId: first.id, title: DEFAULT_SCENE }, shots: [] };
        bySceneId.set("__none", ghost);
        groups[0].scenes.push(ghost);
      }
      ghost.shots.push(shot);
    }
  }
  return groups;
}

export const orderShots = (p) => orderedStructure(p).flatMap((g) => g.scenes.flatMap((s) => s.shots));

/**
 * Brings a project to the episode/scene model. Old projects kept "episode" and "scene" as free
 * text on every shot: each distinct pair becomes a real scene, in order of first appearance.
 * Returns true when something changed.
 */
export function migrateStructure(p, newId) {
  let changed = false;
  if (!Array.isArray(p.episodes)) { p.episodes = []; changed = true; }
  if (!Array.isArray(p.scenes)) { p.scenes = []; changed = true; }
  p.shots ||= [];
  const known = (s) => s.sceneId && p.scenes.some((sc) => sc.id === s.sceneId);
  if (p.shots.some((s) => !known(s))) {
    const episodes = new Map(p.episodes.map((e) => [norm(e.title), e]));
    const scenes = new Map(p.scenes.map((sc) => [`${sc.episodeId}\0${norm(sc.title)}`, sc]));
    for (const s of p.shots) {
      if (known(s)) continue;
      const episodeTitle = String(s.episode || "").trim() || DEFAULT_EPISODE;
      const sceneTitle = String(s.scene || "").trim() || DEFAULT_SCENE;
      let episode = episodes.get(norm(episodeTitle));
      if (!episode) { episode = { id: newId(), title: episodeTitle }; p.episodes.push(episode); episodes.set(norm(episodeTitle), episode); }
      const key = `${episode.id}\0${norm(sceneTitle)}`;
      let scene = scenes.get(key);
      if (!scene) { scene = { id: newId(), episodeId: episode.id, title: sceneTitle, fromScript: false }; p.scenes.push(scene); scenes.set(key, scene); }
      s.sceneId = scene.id;
      changed = true;
    }
  }
  if (!p.episodes.length) { p.episodes.push({ id: newId(), title: DEFAULT_EPISODE }); changed = true; }
  for (const sc of p.scenes)
    if (!p.episodes.some((e) => e.id === sc.episodeId)) { sc.episodeId = p.episodes[0].id; changed = true; }
  for (const s of p.shots)
    if ("episode" in s || "scene" in s) { delete s.episode; delete s.scene; changed = true; }
  return changed;
}

// Pairs script headings with existing items: same title first, then spare script-born items
// by position (a renamed heading keeps its scene), anything else is new.
function reconcile(list, titles, make) {
  const used = new Set();
  const bound = titles.map(() => null);
  titles.forEach((t, i) => {
    const hit = list.find((x) => !used.has(x) && norm(x.title) === norm(t));
    if (hit) { used.add(hit); bound[i] = hit; }
  });
  const spare = list.filter((x) => !used.has(x) && x.fromScript);
  titles.forEach((t, i) => {
    if (bound[i]) return;
    const hit = spare.shift();
    if (hit) { used.add(hit); bound[i] = hit; }
  });
  titles.forEach((t, i) => { if (!bound[i]) bound[i] = make(t); });
  titles.forEach((t, i) => { bound[i].title = t; bound[i].fromScript = true; });
  return { bound, rest: list.filter((x) => !used.has(x)) };
}

/** Makes scenes (and episodes) follow the headings of the script. Scenes with shots are never removed. */
export function syncFromScript(p, newId) {
  const found = parseScript(p.script || "");
  if (!found.length) return false;
  const before = JSON.stringify([p.episodes, p.scenes]);
  const episodeHeads = found.filter((h) => h.kind === "episode");
  const sceneHeads = found.filter((h) => h.kind === "scene");
  const hasShots = (sc) => (p.shots || []).some((s) => s.sceneId === sc.id);

  if (episodeHeads.length) {
    const { bound, rest } = reconcile(p.episodes, episodeHeads.map((h) => h.title), (title) => ({ id: newId(), title }));
    const keep = rest.filter((e) => !e.fromScript || p.scenes.some((sc) => sc.episodeId === e.id));
    keep.forEach((e) => { e.fromScript = false; });
    p.episodes = [...bound, ...keep];
  }
  const episodeAt = (index) => {  // episode in force at a text position
    let current = episodeHeads.length ? p.episodes.find((e) => norm(e.title) === norm(episodeHeads[0].title)) : null;
    for (const h of episodeHeads) if (h.index <= index) current = p.episodes.find((e) => norm(e.title) === norm(h.title));
    return current || p.episodes[0];
  };
  if (sceneHeads.length) {
    const { bound, rest } = reconcile(p.scenes, sceneHeads.map((h) => h.title), (title) => ({ id: newId(), episodeId: null, title }));
    bound.forEach((sc, i) => {
      if (episodeHeads.length || !sc.episodeId) sc.episodeId = episodeAt(sceneHeads[i].index)?.id || p.episodes[0]?.id;
    });
    const keep = rest.filter((sc) => !sc.fromScript || hasShots(sc));
    keep.forEach((sc) => { sc.fromScript = false; });
    p.scenes = [...bound, ...keep];
  }
  if (!p.episodes.length) p.episodes.push({ id: newId(), title: DEFAULT_EPISODE });
  for (const sc of p.scenes)
    if (!p.episodes.some((e) => e.id === sc.episodeId)) sc.episodeId = p.episodes[0].id;
  return before !== JSON.stringify([p.episodes, p.scenes]);
}

/** New script text with a renamed heading, or null when the old heading is not in the text. */
export function renameHeading(text, oldTitle, newTitle) {
  const lines = String(text || "").split("\n");
  const target = norm(oldTitle);
  const i = lines.findIndex((l) => norm(l) === target);
  if (i < 0) return null;
  lines[i] = lines[i].match(/^\s*/)[0] + newTitle.trim();
  return lines.join("\n");
}

/** Moves a shot (within its scene), a scene (across episodes too) or an episode by one step. */
export function moveItem(p, kind, id, direction) {
  const step = direction < 0 ? -1 : 1;
  if (kind === "shot") {
    const shot = p.shots.find((s) => s.id === id);
    if (!shot) return false;
    const siblings = orderedStructure(p).flatMap((g) => g.scenes).find((e) => e.shots.includes(shot))?.shots || [];
    const other = siblings[siblings.indexOf(shot) + step];
    if (!other) return false;
    const a = p.shots.indexOf(shot), b = p.shots.indexOf(other);
    [p.shots[a], p.shots[b]] = [p.shots[b], p.shots[a]];
    return true;
  }
  if (kind === "episode") {
    const i = p.episodes.findIndex((e) => e.id === id), j = i + step;
    if (i < 0 || j < 0 || j >= p.episodes.length) return false;
    [p.episodes[i], p.episodes[j]] = [p.episodes[j], p.episodes[i]];
    return true;
  }
  if (kind === "scene") {
    const flat = orderedStructure(p).flatMap((g) => g.scenes.map((e) => e.scene));
    const scene = flat.find((sc) => sc.id === id);
    const neighbour = flat[flat.indexOf(scene) + step];
    if (!scene || !neighbour) return false;
    if (neighbour.episodeId === scene.episodeId) {
      const a = p.scenes.indexOf(scene), b = p.scenes.indexOf(neighbour);
      [p.scenes[a], p.scenes[b]] = [p.scenes[b], p.scenes[a]];
    } else {  // crossing an episode border: the scene joins the next or previous episode
      p.scenes.splice(p.scenes.indexOf(scene), 1);
      scene.episodeId = neighbour.episodeId;
      p.scenes.splice(p.scenes.indexOf(neighbour) + (step < 0 ? 1 : 0), 0, scene);
    }
    return true;
  }
  return false;
}

const clip = (t, n = 300) => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/** The film as plain text for the assistant: it sees the same tree as the user. */
export function describeStructure(p) {
  const tree = orderedStructure(p), multi = tree.length > 1;
  let n = 0;
  const lines = [];
  for (const g of tree) {
    if (multi) lines.push(`Эпизод «${g.episode.title}»`);
    for (const { scene, shots } of g.scenes) {
      lines.push(`${multi ? "  " : ""}Сцена «${scene.title}»${shots.length ? "" : " (шотов пока нет)"}`);
      for (const s of shots) {
        n++;
        const from = s.endReferenceId ? "из начального и конечного кадра" : s.referenceId ? "из одного кадра" : s.referenceIds?.length ? "по героям и местам" : "из текста";
        const parts = [`${multi ? "    " : "  "}Шот ${n} «${s.title}», ${s.duration || 5} с, ${from}.`];
        if (s.description) parts.push(`Описание: ${clip(s.description)}`);
        if (s.videoPrompt) parts.push(`Промпт шота: ${clip(s.videoPrompt)}`);
        if (s.imagePrompt) parts.push(`Промпт кадра: ${clip(s.imagePrompt)}`);
        lines.push(parts.join(" "));
      }
    }
  }
  return lines.join("\n") || "Шотов пока нет.";
}

/** Vocabulary the whole product and the assistant share. */
export const GLOSSARY =
  "Термины: кадр это одно изображение. Шот это видео, снятое из текста, из одного кадра или из начального и конечного кадра. " +
  "Дубль это одна попытка снять шот. Шоты складываются в сцену, сцены в эпизод, эпизоды в фильм. Никогда не называй шот кадром.";
