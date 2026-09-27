import { ARENA_HALF_SIZE, ARENA_LAYOUT, RAMP_SLOPE_DEG, type ArenaLayout, validateArenaLayout } from "../layout";
import "./style.css";

type Category = "obstacles" | "platforms" | "swampZones" | "iceZones" | "trampolines" | "spawns" | "pickups";
type Item = ArenaLayout[Category][number];
type Selected = { category: Category; index: number };
type Drag = { pointerId: number; offsetX: number; offsetZ: number; before: string };

const HALF = ARENA_HALF_SIZE;
const RAMP_SLOPE_RAD = RAMP_SLOPE_DEG * Math.PI / 180;
const VIEW = HALF + 2;
const CATEGORIES: readonly Category[] = [
  "obstacles", "platforms", "swampZones", "iceZones", "trampolines", "spawns", "pickups",
];
const META: Record<Category, { label: string; singular: string; color: string; symbol: string; hint: string }> = {
  obstacles: { label: "Препятствия", singular: "Препятствие", color: "#eb7190", symbol: "▣", hint: "Твёрдый блок; высота влияет на попадания и проход." },
  platforms: { label: "Платформы", singular: "Платформа", color: "#efae6a", symbol: "▤", hint: "Площадка с одним подъёмом. Пунктир показывает рампу." },
  swampZones: { label: "Болото", singular: "Болото", color: "#b18367", symbol: "◉", hint: "Замедляет без скольжения. Радиус указан в метрах." },
  iceZones: { label: "Лёд", singular: "Лёд", color: "#77d9ed", symbol: "◉", hint: "Скользкая зона. Радиус указан в метрах." },
  trampolines: { label: "Батуты", singular: "Батут", color: "#b58aff", symbol: "◎", hint: "Зона запуска игрока вверх." },
  spawns: { label: "Точки появления", singular: "Точка появления", color: "#a9e789", symbol: "●", hint: "Сервер выбирает эти точки по очереди." },
  pickups: { label: "Бонусы", singular: "Бонус", color: "#e6e46a", symbol: "◆", hint: "Одна точка для каждого вида бонуса." },
};
const KINDS = ["speed", "shield", "impulse"] as const;
const localApiUrl = import.meta.env.DEV
  ? `${window.location.protocol}//${window.location.hostname}:5174/__arena-layout`
  : null;
const KIND_LABELS: Record<(typeof KINDS)[number], string> = {
  speed: "Скорость", shield: "Щит", impulse: "Импульс",
};
function getRoot(): HTMLDivElement {
  const node = document.querySelector<HTMLDivElement>("#editor-root");
  if (node === null) throw new Error("Editor root is missing");
  return node;
}
const root = getRoot();

root.innerHTML = `
  <div class="editor-shell">
    <header class="topbar">
      <a class="brand" href="/"><span class="brand-mark">KA</span><span>KABAN ARENA</span></a>
      <span class="topbar-separator"></span>
      <div><h1 class="page-title">Редактор карты</h1><p class="page-subtitle">План арены · расстановка объектов</p></div>
      <div class="topbar-actions">
        <a class="quiet-link" href="/">← К игре</a>
        <button class="button" id="download-button" type="button">↓ Скачать JSON</button>
        <button class="button primary" id="save-button" type="button">Сохранить карту</button>
      </div>
    </header>
    <main class="workspace">
      <aside class="sidebar">
        <p class="panel-eyebrow">Добавить объект</p>
        <div class="tool-list" id="tool-list"></div>
        <div class="section-line"></div>
        <p class="panel-eyebrow">Файл карты</p>
        <div class="file-actions">
          <button class="button" id="import-button" type="button">↑ Открыть JSON</button>
          <button class="button" id="reset-button" type="button">↺ Вернуть загруженную</button>
          <input id="file-input" type="file" accept="application/json,.json" hidden />
        </div>
        <p class="sidebar-note">Карта хранится в <strong>одном файле</strong> <code>shared/arena-layout.json</code>. Локальная кнопка сохранения меняет его напрямую. После сохранения перезапустите сервер игры и обновите страницу игры.</p>
        <div class="section-line"></div>
        <p class="panel-eyebrow">Управление</p>
        <p class="sidebar-note">Перетащите объект на плане. <span class="keycap">Shift</span> при перетаскивании — шаг 0,1 м. <span class="keycap">Del</span> — удалить. <span class="keycap">Ctrl Z</span> — отменить.</p>
      </aside>
      <section class="stage" aria-label="План арены">
        <div class="stage-toolbar">
          <span class="stage-heading">Вид сверху <span style="color:#8ba5aa;font-weight:500">· X → / Z ↓</span></span>
          <span class="stage-chip">Арена <strong>33,6 × 33,6 м</strong></span>
          <button class="button tiny" id="snap-button" type="button" aria-pressed="true">Привязка 0,5 м: вкл</button>
          <button class="button tiny" id="undo-button" type="button" title="Отменить (Ctrl+Z)">↶</button>
          <button class="button tiny" id="redo-button" type="button" title="Повторить (Ctrl+Shift+Z)">↷</button>
        </div>
        <div class="map-card"><svg id="map" class="map-svg" viewBox="-${VIEW} -${VIEW} ${VIEW * 2} ${VIEW * 2}" aria-label="Схема карты с объектами" role="img"></svg></div>
        <div class="map-hint"><span>Сетка <strong>1 м</strong> · координаты совпадают с игрой</span><span id="cursor-coords">X 0,0 · Z 0,0</span></div>
      </section>
      <aside class="sidebar right">
        <p class="panel-eyebrow">Свойства</p>
        <div id="inspector"></div>
        <div id="validation"></div>
      </aside>
    </main>
    <footer class="statusbar"><span class="live-dot"></span><span id="source-label">Загрузка карты…</span><span id="dirty-label"></span><span class="status-message" id="status-message"></span></footer>
  </div>
`;

function element<T extends HTMLElement | SVGElement>(selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`Missing editor element: ${selector}`);
  return found;
}

const svg = element<SVGSVGElement>("#map");
const inspector = element<HTMLDivElement>("#inspector");
const toolList = element<HTMLDivElement>("#tool-list");
const validationBox = element<HTMLDivElement>("#validation");
const statusMessage = element<HTMLSpanElement>("#status-message");
const fileInput = element<HTMLInputElement>("#file-input");
const snapButton = element<HTMLButtonElement>("#snap-button");
const undoButton = element<HTMLButtonElement>("#undo-button");
const redoButton = element<HTMLButtonElement>("#redo-button");

let layout: ArenaLayout = structuredClone(ARENA_LAYOUT);
let loadedSnapshot = JSON.stringify(layout);
let savedSnapshot = loadedSnapshot;
let selected: Selected | null = null;
let drag: Drag | null = null;
let snapEnabled = true;
let history = [loadedSnapshot];
let historyIndex = 0;
let source = "Встроенная карта";

function items(category: Category): Item[] {
  return layout[category] as Item[];
}

function itemAt(selection: Selected): Item | undefined {
  return items(selection.category)[selection.index];
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function safe(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function setStatus(message: string, error = false): void {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", error);
}

function commit(before?: string): void {
  const snapshot = JSON.stringify(layout);
  if (snapshot === (before ?? history[historyIndex])) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  historyIndex = history.length - 1;
  render();
}

function undo(): void {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  layout = JSON.parse(history[historyIndex] ?? "{}") as ArenaLayout;
  ensureSelection();
  render();
  setStatus("Последнее изменение отменено.");
}

function redo(): void {
  if (historyIndex >= history.length - 1) return;
  historyIndex += 1;
  layout = JSON.parse(history[historyIndex] ?? "{}") as ArenaLayout;
  ensureSelection();
  render();
  setStatus("Изменение восстановлено.");
}

function ensureSelection(): void {
  if (selected !== null && itemAt(selected) === undefined) selected = null;
}

function point(event: PointerEvent): { x: number; z: number } {
  const p = svg.createSVGPoint();
  p.x = event.clientX;
  p.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (matrix === null) return { x: 0, z: 0 };
  const world = p.matrixTransform(matrix.inverse());
  return { x: world.x, z: world.y };
}

function snap(value: number, fine: boolean): number {
  const step = fine ? .1 : snapEnabled ? .5 : .01;
  return Math.round(value / step) * step;
}

function bounds(category: Category, item: Item): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let hx = .4;
  let hz = .4;
  let extraMinX = 0;
  let extraMaxX = 0;
  let extraMinZ = 0;
  let extraMaxZ = 0;
  if (category === "obstacles" || category === "platforms") {
    const box = item as ArenaLayout["obstacles"][number];
    hx = box.hx;
    hz = box.hz;
  } else if (category === "iceZones" || category === "swampZones" || category === "trampolines") {
    hx = hz = (item as ArenaLayout["iceZones"][number]).radius;
  }
  if (category === "platforms") {
    const platform = item as ArenaLayout["platforms"][number];
    const run = platform.topY / Math.tan(RAMP_SLOPE_RAD);
    if (platform.rampSide === "+x") extraMaxX = run;
    if (platform.rampSide === "-x") extraMinX = run;
    if (platform.rampSide === "+z") extraMaxZ = run;
    if (platform.rampSide === "-z") extraMinZ = run;
  }
  return {
    minX: -HALF + hx + extraMinX, maxX: HALF - hx - extraMaxX,
    minZ: -HALF + hz + extraMinZ, maxZ: HALF - hz - extraMaxZ,
  };
}

function clampItemPosition(category: Category, item: Item): void {
  const p = item as { x: number; z: number };
  const limit = bounds(category, item);
  p.x = Math.max(limit.minX, Math.min(limit.maxX, p.x));
  p.z = Math.max(limit.minZ, Math.min(limit.maxZ, p.z));
  p.x = Math.round(p.x * 100) / 100;
  p.z = Math.round(p.z * 100) / 100;
}

function attrs(category: Category, index: number): string {
  return `data-category="${category}" data-index="${index}" class="map-item ${selected?.category === category && selected.index === index ? "selected" : ""}"`;
}

function ringRect(x: number, z: number, hx: number, hz: number): string {
  return `<rect class="selection-ring" x="${x - hx - .13}" y="${z - hz - .13}" width="${2 * (hx + .13)}" height="${2 * (hz + .13)}" rx=".12"/>`;
}

function rampShape(p: ArenaLayout["platforms"][number]): string {
  const run = p.topY / Math.tan(RAMP_SLOPE_RAD);
  const w = p.rampWidth;
  let x = p.x - w / 2;
  let z = p.z - w / 2;
  let width = w;
  let height = w;
  let fromX = p.x;
  let fromZ = p.z;
  let toX = p.x;
  let toZ = p.z;
  if (p.rampSide === "+z") { z = p.z + p.hz; height = run; fromZ = z + run * .75; toZ = z + run * .25; }
  if (p.rampSide === "-z") { z = p.z - p.hz - run; height = run; fromZ = z + run * .25; toZ = z + run * .75; }
  if (p.rampSide === "+x") { x = p.x + p.hx; width = run; fromX = x + run * .75; toX = x + run * .25; }
  if (p.rampSide === "-x") { x = p.x - p.hx - run; width = run; fromX = x + run * .25; toX = x + run * .75; }
  return `<rect class="ramp" x="${x}" y="${z}" width="${width}" height="${height}" rx=".08"/><line class="ramp-arrow" x1="${fromX}" y1="${fromZ}" x2="${toX}" y2="${toZ}" marker-end="url(#ramp-arrow)"/>`;
}

function drawMap(): void {
  const parts: string[] = [`
    <defs>
      <pattern id="arena-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 L 0 0 0 1" fill="none" stroke="#73929a" stroke-opacity=".18" stroke-width=".045"/></pattern>
      <marker id="ramp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#f8d0a5" stroke-width="1.5"/></marker>
    </defs>
    <rect class="arena-floor" x="-${HALF}" y="-${HALF}" width="${HALF * 2}" height="${HALF * 2}" rx=".22"/>
    <rect class="arena-grid" x="-${HALF}" y="-${HALF}" width="${HALF * 2}" height="${HALF * 2}"/>
    <line class="axis" x1="-${HALF}" y1="0" x2="${HALF}" y2="0"/><line class="axis" x1="0" y1="-${HALF}" x2="0" y2="${HALF}"/>
    <text class="grid-label" x="-${HALF}" y="-${HALF + .5}">−16.8</text><text class="grid-label" x="${HALF - .3}" y="${HALF + .7}">+16.8</text>
  `];

  for (const category of ["swampZones", "iceZones", "trampolines"] as const) {
    items(category).forEach((raw, index) => {
      const zone = raw as ArenaLayout["iceZones"][number];
      const color = META[category].color;
      parts.push(`<g ${attrs(category, index)}><circle cx="${zone.x}" cy="${zone.z}" r="${zone.radius}" fill="${color}" fill-opacity=".36" stroke="${color}" stroke-width=".12"/>`);
      if (category === "trampolines") parts.push(`<circle cx="${zone.x}" cy="${zone.z}" r="${zone.radius * .68}" fill="none" stroke="${color}" stroke-width=".1" pointer-events="none"/>`);
      if (selected?.category === category && selected.index === index) parts.push(`<circle class="selection-ring" cx="${zone.x}" cy="${zone.z}" r="${zone.radius + .15}"/>`);
      parts.push(`<text class="map-label" x="${zone.x}" y="${zone.z}">${category === "swampZones" ? "Б" : category === "iceZones" ? "Л" : "↥"}</text></g>`);
    });
  }

  items("obstacles").forEach((raw, index) => {
    const box = raw as ArenaLayout["obstacles"][number];
    parts.push(`<g ${attrs("obstacles", index)}><rect x="${box.x - box.hx}" y="${box.z - box.hz}" width="${box.hx * 2}" height="${box.hz * 2}" rx=".1" fill="#a44864" stroke="#f08aa5" stroke-width=".12"/>`);
    if (selected?.category === "obstacles" && selected.index === index) parts.push(ringRect(box.x, box.z, box.hx, box.hz));
    parts.push(`<text class="map-label" x="${box.x}" y="${box.z}">${number(box.topY)}м</text></g>`);
  });

  items("platforms").forEach((raw, index) => {
    const p = raw as ArenaLayout["platforms"][number];
    parts.push(`<g ${attrs("platforms", index)}>${rampShape(p)}<rect x="${p.x - p.hx}" y="${p.z - p.hz}" width="${p.hx * 2}" height="${p.hz * 2}" rx=".1" fill="#9a603a" stroke="#f4b77b" stroke-width=".12"/>`);
    if (selected?.category === "platforms" && selected.index === index) parts.push(ringRect(p.x, p.z, p.hx, p.hz));
    parts.push(`<text class="map-label" x="${p.x}" y="${p.z}">${number(p.topY)}м</text></g>`);
  });

  items("spawns").forEach((raw, index) => {
    const spawn = raw as ArenaLayout["spawns"][number];
    parts.push(`<g ${attrs("spawns", index)}><circle cx="${spawn.x}" cy="${spawn.z}" r=".57" fill="#517348" stroke="#b9e69d" stroke-width=".11"/>`);
    if (selected?.category === "spawns" && selected.index === index) parts.push(`<circle class="selection-ring" cx="${spawn.x}" cy="${spawn.z}" r=".73"/>`);
    parts.push(`<text class="map-label" x="${spawn.x}" y="${spawn.z}">${index + 1}</text></g>`);
  });

  items("pickups").forEach((raw, index) => {
    const pickup = raw as ArenaLayout["pickups"][number];
    const { x, z } = pickup;
    parts.push(`<g ${attrs("pickups", index)}><path d="M ${x} ${z - .65} L ${x + .65} ${z} L ${x} ${z + .65} L ${x - .65} ${z} Z" fill="#8b8f3d" stroke="#f0ee8a" stroke-width=".12"/>`);
    if (selected?.category === "pickups" && selected.index === index) parts.push(`<circle class="selection-ring" cx="${x}" cy="${z}" r=".82"/>`);
    parts.push(`<text class="map-label" x="${x}" y="${z}">${pickup.kind === "speed" ? "С" : pickup.kind === "shield" ? "Щ" : "И"}</text></g>`);
  });

  parts.push(`<circle class="fixed-core" cx="0" cy="0" r=".29"/><text class="fixed-core-label" x="0" y="1.05">SUPER</text>`);
  svg.innerHTML = parts.join("");
}

function drawTools(): void {
  toolList.innerHTML = CATEGORIES.map((category) => {
    const meta = META[category];
    const cannotAddPickup = category === "pickups" && items("pickups").length >= KINDS.length;
    return `<button type="button" class="tool" data-add="${category}" ${cannotAddPickup ? "disabled" : ""} title="${safe(meta.hint)}"><span class="tool-icon" style="color:${meta.color};background:${meta.color}24">${meta.symbol}</span><span><span class="tool-name">${meta.label}</span><span class="tool-count">${items(category).length} на карте</span></span><span class="add-mark">+</span></button>`;
  }).join("");
}

function field(name: string, label: string, value: number, extra = ""): string {
  return `<div class="field"><label for="field-${name}">${label}</label><input id="field-${name}" data-field="${name}" type="number" step="0.1" value="${number(value)}" ${extra}/></div>`;
}

function drawInspector(): void {
  if (selected === null) {
    inspector.innerHTML = `<div class="inspector-empty">Выберите цветной объект на плане или добавьте новый слева.<br/><br/>После выбора здесь появятся координаты и размеры.</div>`;
    return;
  }
  const item = itemAt(selected);
  if (item === undefined) { selected = null; drawInspector(); return; }
  const category = selected.category;
  const meta = META[category];
  const options = CATEGORIES.flatMap((type) => items(type).map((entry, index) => {
    const suffix = type === "pickups" ? ` · ${KIND_LABELS[(entry as ArenaLayout["pickups"][number]).kind]}` : "";
    const value = `${type}:${index}`;
    return `<option value="${value}" ${selected?.category === type && selected.index === index ? "selected" : ""}>${META[type].singular} ${index + 1}${suffix}</option>`;
  })).join("");
  let extra = "";
  if (category === "obstacles" || category === "platforms") {
    const box = item as ArenaLayout["obstacles"][number];
    extra += field("hx", "Половина ширины X, м", box.hx, 'min="0.2" max="8"');
    extra += field("hz", "Половина длины Z, м", box.hz, 'min="0.2" max="8"');
    extra += field("topY", "Высота, м", box.topY, 'min="0.2" max="4"');
  }
  if (category === "platforms") {
    const p = item as ArenaLayout["platforms"][number];
    extra += `<div class="field"><label for="field-rampSide">Сторона рампы</label><select id="field-rampSide" data-field="rampSide">${["+x", "-x", "+z", "-z"].map((side) => `<option value="${side}" ${p.rampSide === side ? "selected" : ""}>${side.toUpperCase()}</option>`).join("")}</select></div>`;
    extra += field("rampWidth", "Ширина рампы, м", p.rampWidth, 'min="0.4" max="8"');
    extra += `<div class="field-help">Рампа рассчитывается из высоты платформы с уклоном ${RAMP_SLOPE_DEG}°. На плане показана пунктиром.</div>`;
  }
  if (category === "swampZones" || category === "iceZones" || category === "trampolines") {
    extra += field("radius", "Радиус, м", (item as ArenaLayout["iceZones"][number]).radius, 'min="0.4" max="8"');
  }
  if (category === "pickups") {
    const pickup = item as ArenaLayout["pickups"][number];
    extra += `<div class="field wide"><label for="field-kind">Тип бонуса</label><select id="field-kind" data-field="kind">${KINDS.map((kind) => `<option value="${kind}" ${pickup.kind === kind ? "selected" : ""}>${KIND_LABELS[kind]}</option>`).join("")}</select></div>`;
  }
  inspector.innerHTML = `
    <h2 class="inspector-title" style="color:${meta.color}">${meta.singular} ${selected.index + 1}</h2>
    <div class="inspector-subtitle">${meta.hint}</div>
    <div class="field wide" style="margin-bottom:14px"><label for="object-picker">Выбранный объект</label><select id="object-picker">${options}</select></div>
    <div class="inspector-fields">
      ${field("x", "Координата X, м", item.x, 'min="-16.8" max="16.8"')}
      ${field("z", "Координата Z, м", item.z, 'min="-16.8" max="16.8"')}
      ${extra}
    </div>
    <div class="inspector-actions"><button class="button" id="duplicate-button" type="button">Дублировать</button><button class="button danger" id="delete-button" type="button">Удалить</button></div>
  `;
}

function drawValidation(): void {
  try {
    validateArenaLayout(layout);
    validationBox.innerHTML = `<div class="validation ok">✓ Формат и основные ограничения карты проверены. Проходимость проверьте в игре.</div>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка карты";
    validationBox.innerHTML = `<div class="validation bad"><strong>Исправьте перед сохранением:</strong><ul><li>${safe(message).replaceAll("\n", "</li><li>")}</li></ul></div>`;
  }
}

function render(): void {
  ensureSelection();
  drawMap();
  drawTools();
  drawInspector();
  drawValidation();
  undoButton.disabled = historyIndex <= 0;
  redoButton.disabled = historyIndex >= history.length - 1;
  element<HTMLSpanElement>("#dirty-label").textContent = JSON.stringify(layout) === savedSnapshot ? "· Сохранено" : "· Есть изменения";
  element<HTMLSpanElement>("#source-label").textContent = source;
}

function add(category: Category): void {
  let item: Item;
  if (category === "obstacles") item = { x: 0, z: 0, hx: 1, hz: 1, topY: 1 };
  else if (category === "platforms") item = { x: 0, z: 0, hx: 1.5, hz: 1.5, topY: 1.8, rampSide: "+z", rampWidth: 1.5 };
  else if (category === "spawns") item = { x: 0, z: 0 };
  else if (category === "pickups") {
    const used = new Set(items("pickups").map((entry) => (entry as ArenaLayout["pickups"][number]).kind));
    const kind = KINDS.find((candidate) => !used.has(candidate));
    if (kind === undefined) { setStatus("Все три бонуса уже расставлены.", true); return; }
    item = { kind, x: 0, z: 0 };
  } else item = { x: 0, z: 0, radius: category === "trampolines" ? 1.2 : 2 };
  items(category).push(item);
  selected = { category, index: items(category).length - 1 };
  commit();
  setStatus("Объект добавлен. Перетащите его на нужное место.");
}

function removeSelected(): void {
  if (selected === null) return;
  const { category, index } = selected;
  items(category).splice(index, 1);
  selected = null;
  commit();
  setStatus("Объект удалён.");
}

function duplicateSelected(): void {
  if (selected === null) return;
  const original = itemAt(selected);
  if (original === undefined) return;
  const copy = structuredClone(original);
  if (selected.category === "pickups") {
    const used = new Set(items("pickups").map((entry) => (entry as ArenaLayout["pickups"][number]).kind));
    const free = KINDS.find((kind) => !used.has(kind));
    if (free === undefined) { setStatus("Уже есть по одному бонусу каждого типа.", true); return; }
    (copy as ArenaLayout["pickups"][number]).kind = free;
  }
  copy.x += 1;
  copy.z += 1;
  clampItemPosition(selected.category, copy);
  items(selected.category).push(copy);
  selected = { category: selected.category, index: items(selected.category).length - 1 };
  commit();
  setStatus("Копия добавлена.");
}

function exportFile(): void {
  try {
    const valid = validateArenaLayout(layout);
    const blob = new Blob([`${JSON.stringify(valid, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "arena-layout.json";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("JSON скачан. Для применения замените shared/arena-layout.json и перезапустите сервер игры.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Карта содержит ошибку.", true);
  }
}

async function save(): Promise<void> {
  let valid: ArenaLayout;
  try {
    valid = validateArenaLayout(layout);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Карта содержит ошибку.", true);
    drawValidation();
    return;
  }
  if (localApiUrl === null) {
    exportFile();
    return;
  }
  const button = element<HTMLButtonElement>("#save-button");
  button.disabled = true;
  try {
    const response = await fetch(localApiUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Arena-Editor": "1" },
      body: JSON.stringify(valid),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      throw new Error(`Save endpoint unavailable (${response.status})`);
    }
    savedSnapshot = JSON.stringify(layout);
    loadedSnapshot = savedSnapshot;
    source = "shared/arena-layout.json";
    render();
    setStatus("Карта записана в shared/arena-layout.json. Перезапустите сервер игры и обновите игру.");
  } catch {
    exportFile();
    setStatus("Прямая запись доступна в локальном редакторе. JSON скачан; замените им shared/arena-layout.json.");
  } finally {
    button.disabled = false;
  }
}

async function importFile(file: File): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await file.text());
    const next = validateArenaLayout(parsed);
    layout = structuredClone(next);
    loadedSnapshot = JSON.stringify(layout);
    selected = null;
    history = [loadedSnapshot];
    historyIndex = 0;
    source = `Открыт: ${file.name}`;
    render();
    setStatus("Карта загружена. Нажмите «Сохранить карту», чтобы записать её в проект.");
  } catch (error) {
    setStatus(`Не удалось открыть JSON: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

svg.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const node = target.closest<SVGGElement>("[data-category][data-index]");
  if (node === null) { selected = null; render(); return; }
  const category = node.dataset.category as Category;
  const index = Number(node.dataset.index);
  if (!CATEGORIES.includes(category) || !Number.isInteger(index)) return;
  selected = { category, index };
  const item = itemAt(selected);
  if (item === undefined) return;
  const world = point(event);
  drag = { pointerId: event.pointerId, offsetX: item.x - world.x, offsetZ: item.z - world.z, before: JSON.stringify(layout) };
  svg.setPointerCapture(event.pointerId);
  render();
});

svg.addEventListener("pointermove", (event) => {
  const world = point(event);
  element<HTMLSpanElement>("#cursor-coords").textContent = `X ${number(world.x)} · Z ${number(world.z)}`;
  if (drag === null || drag.pointerId !== event.pointerId || selected === null) return;
  const item = itemAt(selected);
  if (item === undefined) return;
  item.x = snap(world.x + drag.offsetX, event.shiftKey);
  item.z = snap(world.z + drag.offsetZ, event.shiftKey);
  clampItemPosition(selected.category, item);
  drawMap();
  drawInspector();
  drawValidation();
  element<HTMLSpanElement>("#dirty-label").textContent = JSON.stringify(layout) === savedSnapshot ? "· Сохранено" : "· Есть изменения";
});

function endDrag(event: PointerEvent): void {
  if (drag === null || drag.pointerId !== event.pointerId) return;
  const before = drag.before;
  drag = null;
  if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
  commit(before);
}
svg.addEventListener("pointerup", endDrag);
svg.addEventListener("pointercancel", endDrag);

toolList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("[data-add]");
  const category = button?.dataset.add as Category | undefined;
  if (category !== undefined && CATEGORIES.includes(category)) add(category);
});

inspector.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.id === "object-picker") {
    const [category, indexText] = target.value.split(":");
    if (CATEGORIES.includes(category as Category)) selected = { category: category as Category, index: Number(indexText) };
    render();
    return;
  }
  if (selected === null || target.dataset.field === undefined) return;
  const item = itemAt(selected);
  if (item === undefined) return;
  const key = target.dataset.field;
  const mutable = item as unknown as Record<string, number | string>;
  if (key === "rampSide" || key === "kind") mutable[key] = target.value;
  else {
    const value = Number(target.value);
    if (!Number.isFinite(value)) { render(); return; }
    mutable[key] = Math.round(value * 100) / 100;
  }
  clampItemPosition(selected.category, item);
  commit();
});

inspector.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("#delete-button")) removeSelected();
  if (target.closest("#duplicate-button")) duplicateSelected();
});

element<HTMLButtonElement>("#save-button").addEventListener("click", () => { void save(); });
element<HTMLButtonElement>("#download-button").addEventListener("click", exportFile);
element<HTMLButtonElement>("#import-button").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file !== undefined) void importFile(file);
  fileInput.value = "";
});
element<HTMLButtonElement>("#reset-button").addEventListener("click", () => {
  layout = JSON.parse(loadedSnapshot) as ArenaLayout;
  selected = null;
  commit();
  setStatus("Загруженная версия восстановлена.");
});
snapButton.addEventListener("click", () => {
  snapEnabled = !snapEnabled;
  snapButton.textContent = `Привязка 0,5 м: ${snapEnabled ? "вкл" : "выкл"}`;
  snapButton.setAttribute("aria-pressed", String(snapEnabled));
});
undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);
window.addEventListener("keydown", (event) => {
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
  } else if (!editing && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    removeSelected();
  } else if (!editing && event.key === "Escape") {
    selected = null;
    render();
  } else if (!editing && selected !== null && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    const item = itemAt(selected);
    if (item === undefined) return;
    const step = event.shiftKey ? .1 : .5;
    if (event.key === "ArrowLeft") item.x -= step;
    if (event.key === "ArrowRight") item.x += step;
    if (event.key === "ArrowUp") item.z -= step;
    if (event.key === "ArrowDown") item.z += step;
    clampItemPosition(selected.category, item);
    commit();
  }
});

render();
void (async () => {
  if (localApiUrl === null) {
    source = "Встроенная карта";
    render();
    setStatus("В опубликованной версии сохранение скачивает JSON для применения в проекте.");
    return;
  }
  const beforeLoad = loadedSnapshot;
  try {
    const response = await fetch(localApiUrl, { cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return;
    const current: unknown = await response.json();
    // A slow local API must not replace edits or an imported file made while
    // the initial request was in flight.
    if (history.length !== 1 || JSON.stringify(layout) !== beforeLoad || source !== "Встроенная карта") return;
    layout = structuredClone(validateArenaLayout(current));
    loadedSnapshot = JSON.stringify(layout);
    savedSnapshot = loadedSnapshot;
    history = [loadedSnapshot];
    historyIndex = 0;
    source = "shared/arena-layout.json";
    render();
    setStatus("Карта загружена из проекта.");
  } catch {
    source = "Встроенная карта";
    render();
    setStatus("Работаем с встроенной копией карты. Сохранение скачает JSON.");
  }
})();
