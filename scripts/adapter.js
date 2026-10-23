import { ID } from "./constants.js";

/* Adaptador genérico: Item incorporado ao ator, quantidade e moeda em campos numéricos simples.
   Outros sistemas: registrar um adaptador com o mesmo formato via api.registerAdapter(). */

const DEFAULTS = { currencyPath: "", quantityPath: "system.quantity", pricePath: "", currencyName: "Moedas", currencySymbol: "", decimals: 0, eligibleTypes: "" };
const PATH_RE = /^[A-Za-z_]\w*(\.\w+)+$/;
const registry = new Map();
const U = () => foundry.utils;
const STRIP = ["_id", "_stats", "ownership", "folder", "sort"];

export const Generic = {
  id: "generic",
  label: "Genérico (moeda e quantidade numéricas)",
  defaults: DEFAULTS,
  config() { return { ...DEFAULTS, ...(game.settings.get(ID, "generic") ?? {}) }; },
  decimals() { const d = Math.trunc(Number(this.config().decimals)); return Number.isFinite(d) ? Math.min(4, Math.max(0, d)) : 0; },
  factor() { return 10 ** this.decimals(); },
  validPath(p) { return typeof p === "string" && PATH_RE.test(p); },
  hasQuantity() { return this.validPath(this.config().quantityPath); },
  isConfigured() { const c = this.config(); return this.validPath(c.currencyPath) && (!c.quantityPath || this.validPath(c.quantityPath)); },

  toUnits(raw) { return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw * this.factor()) : null; },
  fromUnits(u) { return Number((u / this.factor()).toFixed(this.decimals())); },
  format(u) {
    const c = this.config(), d = this.decimals();
    const n = (u / this.factor()).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
    return `${n} ${c.currencySymbol || c.currencyName}`.trim();
  },
  getBalance(actor) {
    const c = this.config();
    if (!this.validPath(c.currencyPath)) return null;
    const raw = U().getProperty(actor, c.currencyPath);
    return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw * this.factor()) : null;
  },
  async setBalance(actor, units) { await actor.update({ [this.config().currencyPath]: this.fromUnits(units) }); },

  // Sem caminho de quantidade: cada documento Item vale exatamente 1 unidade.
  getQuantity(item) {
    const p = this.config().quantityPath;
    if (!p) return 1;
    if (!this.validPath(p)) return null;
    const raw = U().getProperty(item, p);
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  },
  getPrice(src) {
    const p = this.config().pricePath;
    return this.validPath(p) ? this.toUnits(U().getProperty(src, p)) : null;
  },
  types() { return String(this.config().eligibleTypes).split(",").map(s => s.trim()).filter(Boolean); },
  isTradable(item) {
    const t = this.types();
    if (t.length && !t.includes(item.type)) return false;
    const q = this.getQuantity(item);
    return q !== null && q >= 1;
  },
  listTradable(actor) { return actor.items.filter(i => this.isTradable(i)).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")); },
  plain(x) { return typeof x.toObject === "function" ? x.toObject() : U().deepClone(x); },
  setQty(data, n) { if (this.hasQuantity()) U().setProperty(data, this.config().quantityPath, n); },
  normalize(x) {
    const d = this.plain(x);
    for (const k of STRIP) delete d[k];
    if (d.flags) delete d.flags[ID];
    for (const e of d.effects ?? []) { delete e._id; delete e._stats; delete e.origin; }
    this.setQty(d, 0);
    return d;
  },
  canStack(a, b) { return U().objectsEqual(this.normalize(a), this.normalize(b)); },
  cleanData(item) { const d = this.plain(item); for (const k of STRIP) delete d[k]; return d; },
  prepare(data, qty) { const d = U().deepClone(data); delete d._id; this.setQty(d, qty); return d; },
  createItems(actor, arr) { return actor.createEmbeddedDocuments("Item", arr); },
  restoreItems(actor, arr) { return actor.createEmbeddedDocuments("Item", arr, { keepId: true }); },
  setQuantities(actor, list) {
    const p = this.config().quantityPath;
    if (!this.hasQuantity()) return null;
    return actor.updateEmbeddedDocuments("Item", list.map(({ id, qty }) => ({ _id: id, [p]: qty })));
  },
  deleteItems(actor, ids) { return actor.deleteEmbeddedDocuments("Item", ids); }
};

registry.set("generic", Generic);
export const registerAdapter = a => registry.set(a.id, a);
export const adapter = () => registry.get(game.settings.get(ID, "adapterId")) ?? Generic;

/** Diagnóstico de compatibilidade; actor opcional. */
export function diagnose(actor = null) {
  const A = Generic, c = A.config(), out = [];
  const add = (level, text) => out.push({ level, text, icon: { ok: "fa-circle-check", warn: "fa-triangle-exclamation", error: "fa-circle-xmark" }[level] });
  for (const [k, label, req] of [["currencyPath", "Caminho da moeda", true], ["quantityPath", "Caminho da quantidade", false], ["pricePath", "Caminho do preço", false]]) {
    if (!c[k]) {
      const why = k === "quantityPath" ? "vazio. Cada item da ficha vale 1 unidade (comprar N cria N cópias)." : "vazio. Preços de venda e preços automáticos dependem de valores manuais.";
      add(req ? "error" : "warn", `${label}: ${req ? "não configurado." : why}`);
    }
    else if (!A.validPath(c[k])) add("error", `${label}: formato inválido ("${c[k]}"). Use algo como system.currency.gp.`);
    else add("ok", `${label}: ${c[k]}`);
  }
  if (!actor) { add("warn", "Escolha um personagem para testar os caminhos."); return out; }
  if (A.validPath(c.currencyPath)) {
    const raw = U().getProperty(actor, c.currencyPath);
    if (typeof raw !== "number" || !Number.isFinite(raw)) add("error", `Moeda: o valor em "${c.currencyPath}" não é numérico (${raw === undefined ? "caminho inexistente" : typeof raw}). O comércio será bloqueado.`);
    else {
      add("ok", `Saldo lido: ${A.format(Math.round(raw * A.factor()))}`);
      if (Math.abs(raw * A.factor() - Math.round(raw * A.factor())) > 1e-6) add("warn", "O saldo tem mais casas decimais que a precisão configurada; será arredondado.");
    }
  }
  const items = actor.items.contents;
  let withQty = 0, tradable = 0, noPrice = 0;
  for (const i of items) {
    if (A.getQuantity(i) !== null) withQty++;
    if (A.isTradable(i)) { tradable++; if (A.getPrice(i) === null) noPrice++; }
  }
  add(items.length ? (withQty ? "ok" : "error") : "warn", `Itens: ${items.length} no total, ${withQty} com quantidade legível, ${tradable} negociáveis.`);
  if (noPrice) add("warn", `${noPrice} item(ns) negociável(is) sem preço legível: não poderão ser vendidos ao mercador.`);
  return out;
}
