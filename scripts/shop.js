import { ID } from "./constants.js";
import { adapter } from "./adapter.js";
import { uid, num } from "./util.js";

export const DEFAULT_SHOP = { enabled: false, name: "", description: "", logo: "", banner: "", color: "#c9a227", open: true, buyMult: 1, sellMult: 0.5, allowBuy: true, allowSell: true, limitedMoney: false };

export const isMerchant = a => a?.flags?.[ID]?.shop?.enabled === true;
export const getShop = a => ({ ...DEFAULT_SHOP, ...(a?.flags?.[ID]?.shop ?? {}) });
export const getCatalog = a => Object.values(a?.flags?.[ID]?.catalog ?? {}).filter(e => e?.itemData).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
export const merchantName = a => getShop(a).name?.trim() || a.name;

/** Preço cobrado do jogador por unidade (unidades mínimas) ou null. */
export function entryPrice(entry, shop) {
  if (Number.isSafeInteger(entry.finalPrice) && entry.finalPrice >= 0) return entry.finalPrice;
  const base = Number.isSafeInteger(entry.basePrice) && entry.basePrice >= 0 ? entry.basePrice : adapter().getPrice(entry.itemData);
  return base === null || base === undefined ? null : Math.round(base * num(shop.buyMult, 1));
}
/** Valor pago ao jogador por unidade ou null. */
export function sellPrice(item, shop) {
  const base = adapter().getPrice(item);
  return base === null ? null : Math.round(base * num(shop.sellMult, 0.5));
}

export function eligibleBuyers(user) {
  const map = new Map();
  const add = a => { if (a && !isMerchant(a) && a.testUserPermission(user, "OWNER")) map.set(a.id, a); };
  add(user.character);
  for (const a of game.actors) { if (user.isGM ? a.hasPlayerOwner : true) add(a); }
  return [...map.values()];
}

export async function setMerchantActive(actor, on) {
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
  const upd = {};
  if (!actor.flags?.[ID]?.shop) upd[`flags.${ID}.shop`] = { ...DEFAULT_SHOP, enabled: on };
  else upd[`flags.${ID}.shop.enabled`] = on;
  // Jogadores só recebem o documento do ator (e podem abrir a loja) com ao menos Limitado. Não concede edição.
  if (on && (actor.ownership?.default ?? 0) < L) upd["ownership.default"] = L;
  await actor.update(upd);
}

export async function addToCatalog(actor, item) {
  const A = adapter();
  if (item.documentName !== "Item") return ui.notifications.warn("Arraste apenas itens.");
  if (A.getQuantity(item) === null) return ui.notifications.warn(`"${item.name}" não possui o campo de quantidade configurado e não pode ser negociado.`);
  const data = A.cleanData(item);
  A.setQty(data, 1);
  const same = getCatalog(actor).find(e => A.canStack(e.itemData, data));
  if (same) {
    if (!same.unlimited) await actor.update({ [`flags.${ID}.catalog.${same.id}.stock`]: (same.stock ?? 0) + 1 });
    return same;
  }
  const id = uid();
  const entry = { id, itemData: data, stock: 1, unlimited: false, basePrice: A.getPrice(item), finalPrice: null, icon: "", order: Date.now() };
  await actor.update({ [`flags.${ID}.catalog.${id}`]: entry });
  return entry;
}

/** Importa os itens da ficha do mercador para o catálogo, na quantidade em que estão (a ficha não é alterada).
 *  Itens já importados (mesmo id de origem) são ignorados, então repetir é seguro. */
export async function importFromSheet(actor) {
  const A = adapter(), cat = getCatalog(actor);
  const known = new Set(cat.flatMap(e => e.srcIds ?? []));
  const stock = new Map(cat.map(e => [e.id, e.stock ?? 0])), src = new Map(cat.map(e => [e.id, [...(e.srcIds ?? [])]]));
  const fresh = [], touched = new Set();
  let count = 0;
  for (const item of A.listTradable(actor)) {
    if (known.has(item.id)) continue;
    const q = A.getQuantity(item), data = A.cleanData(item);
    A.setQty(data, 1);
    count++;
    const old = cat.find(e => A.canStack(e.itemData, data));
    if (old) { if (!old.unlimited) stock.set(old.id, stock.get(old.id) + q); src.get(old.id).push(item.id); touched.add(old.id); continue; }
    const f = fresh.find(x => A.canStack(x.itemData, data));
    if (f) { f.stock += q; f.srcIds.push(item.id); continue; }
    fresh.push({ id: uid(), itemData: data, stock: q, unlimited: false, basePrice: A.getPrice(item), finalPrice: null, icon: "", order: Date.now() + fresh.length, srcIds: [item.id] });
  }
  const upd = {};
  for (const id of touched) { upd[`flags.${ID}.catalog.${id}.stock`] = stock.get(id); upd[`flags.${ID}.catalog.${id}.srcIds`] = src.get(id); }
  for (const f of fresh) upd[`flags.${ID}.catalog.${f.id}`] = f;
  if (count) await actor.update(upd);
  return count;
}
