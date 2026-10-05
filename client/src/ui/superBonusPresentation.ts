import { VACUUM_ACTIVE_MS, type SuperBonusKind } from "../../../shared/super-bonuses.mjs";

interface SuperBonusPresentation {
  readonly name: string;
  readonly hint: string;
}

// Brief pickup copy belongs to the HUD; shared names remain available for
// the event feed and the full accessible name of each item.
export const SUPER_BONUS_PRESENTATIONS: Readonly<Record<SuperBonusKind, SuperBonusPresentation>> = {
  sheep: { name: "Овца", hint: "Гонится · взрыв по всем" },
  turkey: { name: "Индейка", hint: "Перья на 2 с" },
  freeze: { name: "Кирпич", hint: "Заморозка на 1 с" },
  boomerang: { name: "Колбаса", hint: "Возвращается · отойди!" },
  jelly: { name: "Холодец", hint: "Подбрасывает вверх" },
  herring: { name: "Селёдка", hint: "Облако · отойди!" },
  swamp: { name: "Болото", hint: "Замедляет на 5 с" },
  ice: { name: "Каток", hint: "Скользкий лёд на 5 с" },
  soda: { name: "Лимонад", hint: "Мина · опасна всем" },
  vacuum: { name: "Пылесос", hint: `Притягивает на ${VACUUM_ACTIVE_MS / 1000} с` },
  grenade: { name: "Граната", hint: "+1 ♥ · мимо: 3 взрыва" },
};
