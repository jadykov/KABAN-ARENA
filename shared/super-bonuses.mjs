// Shared names and direct-hit tuning. Delayed effects NEVER receive the base
// attack damage: this table contains only the extra damage of a flying item.
export const SUPER_BONUS_SLOT_MS = 20_000;
export const MAX_SHEEP = 2;
export const FREEZE_MS = 1_000;
export const TURKEY_MS = 2_000;
export const CONTROL_IMMUNITY_MS = 2_000;

export const SUPER_BONUSES = Object.freeze([
  { id: "01", kind: "sheep", name: "Взрывная овца", hint: "Преследует ближайшего. Опасна и тебе!", color: 0xffe9cd, directWeak: 0, directStrong: 0 },
  { id: "02", kind: "turkey", name: "Индейка-каска", hint: "Попади: перья закроют обзор на 2 секунды", color: 0xc96e3d, directWeak: 12.5, directStrong: 12.5 },
  { id: "05", kind: "freeze", name: "Ледяной кирпич", hint: "Попади: заморозка на 1 секунду", color: 0x83dfff, directWeak: 12.5, directStrong: 12.5 },
  { id: "08", kind: "boomerang", name: "Колбаса-бумеранг", hint: "Возвращается к месту броска. Отойди!", color: 0xcf6154, directWeak: 12.5, directStrong: 25 },
  { id: "14", kind: "jelly", name: "Пружинный холодец", hint: "Попади: подбрось соперника вверх", color: 0xe9ba66, directWeak: 12.5, directStrong: 12.5 },
  { id: "16", kind: "herring", name: "Селёдка с душком", hint: "Облако запаха. Не стой внутри!", color: 0xa5cc65, directWeak: 0, directStrong: 0 },
  { id: "17", kind: "swamp", name: "Болото в пакете", hint: "На 5 секунд меняет поверхность на болото", color: 0x6f914b, directWeak: 0, directStrong: 0 },
  { id: "18", kind: "ice", name: "Карманный каток", hint: "На 5 секунд меняет поверхность на лёд", color: 0x6dbffc, directWeak: 0, directStrong: 0 },
  { id: "23", kind: "soda", name: "Газировка с сюрпризом", hint: "Ставит заметную мину. Опасна и тебе!", color: 0xf69538, directWeak: 0, directStrong: 0 },
  { id: "26", kind: "vacuum", name: "Шар-пылесос", hint: "На 2 секунды притягивает игроков поблизости", color: 0xad85dd, directWeak: 0, directStrong: 0 },
].map((definition) => Object.freeze(definition)));

export const SUPER_BONUS_KINDS = Object.freeze(SUPER_BONUSES.map(({ kind }) => kind));

export function isSuperBonusKind(value) {
  return typeof value === "string" && SUPER_BONUS_KINDS.includes(value);
}

export function getSuperBonus(value) {
  return SUPER_BONUSES.find(({ kind }) => kind === value);
}

export function directBonusDamage(kind, power01) {
  const definition = getSuperBonus(kind);
  return definition === undefined ? 0 : power01 >= 0.8 ? definition.directStrong : definition.directWeak;
}

// The same selection runs on server motion and client prediction. Heights
// refer to the real supporting surface, so a floor patch cannot affect a
// player standing on a roof or travelling above it. Return the original
// effect (no temporary result allocation); the caller retains map surfaces
// when this returns undefined. Optional visibility checks clip through walls.
export function activeTemporarySurface(effects, x, bodyY, z, now, bodyCentreY = 1.1, visible) {
  if (!Number.isFinite(x) || !Number.isFinite(bodyY) || !Number.isFinite(z)
    || !Number.isFinite(now) || !Number.isFinite(bodyCentreY)) return undefined;
  let selected;
  const feetY = bodyY - bodyCentreY;
  for (const effect of effects) {
    if ((effect.kind !== "swamp" && effect.kind !== "ice")
      || effect.createdAt > now || effect.expiresAt <= now
      || effect.radius <= 0 || Math.abs(feetY - effect.y) > 0.200001) continue;
    const dx = x - effect.x;
    const dz = z - effect.z;
    if (dx * dx + dz * dz > effect.radius * effect.radius || (visible && !visible(effect))) continue;
    if (selected === undefined || effect.createdAt > selected.createdAt
      || (effect.createdAt === selected.createdAt && effect.effectId > selected.effectId)) selected = effect;
  }
  return selected;
}
