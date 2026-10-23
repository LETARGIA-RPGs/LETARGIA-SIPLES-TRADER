import { ID, TPL } from "../constants.js";
import { adapter } from "../adapter.js";
import { getShop, getCatalog, isMerchant, merchantName, entryPrice, addToCatalog, importFromSheet } from "../shop.js";
import { num, safeColor, pickImage } from "../util.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class MerchantConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static #all = new Map();
  static DEFAULT_OPTIONS = {
    classes: ["lst-app", "lst-config"], tag: "form",
    window: { title: "Configurar mercador", icon: "fa-solid fa-store", resizable: true },
    position: { width: 640, height: 740 },
    form: { handler: MerchantConfig._onSubmit, submitOnChange: true, closeOnSubmit: false },
    actions: {
      pickLogo: MerchantConfig._onPickLogo, pickBanner: MerchantConfig._onPickBanner, pickIcon: MerchantConfig._onPickIcon,
      resetIcon: MerchantConfig._onResetIcon, removeEntry: MerchantConfig._onRemove, openShop: MerchantConfig._onOpenShop,
      openSheet: MerchantConfig._onOpenSheet, openAdapter: MerchantConfig._onOpenAdapter, importSheet: MerchantConfig._onImportSheet
    }
  };
  static PARTS = { main: { template: TPL("merchant-config.hbs") } };

  constructor(actorId, options = {}) { super({ id: `lst-config-${actorId}`, ...options }); this.actorId = actorId; }
  get actor() { return game.actors.get(this.actorId); }
  get title() { return `Mercador: ${this.actor?.name ?? ""}`; }

  static open(actor) {
    let app = MerchantConfig.#all.get(actor.id);
    if (!app) { app = new MerchantConfig(actor.id); MerchantConfig.#all.set(actor.id, app); }
    app.render({ force: true });
    return app;
  }
  static refreshAll() { for (const a of MerchantConfig.#all.values()) if (a.rendered) a.render(); }
  async _onClose(options) { MerchantConfig.#all.delete(this.actorId); return super._onClose(options); }

  async _prepareContext() {
    const actor = this.actor, A = adapter(), shop = getShop(actor), f = A.factor?.() ?? 1, d = A.decimals?.() ?? 0;
    const dec = u => (u === null || u === undefined ? "" : (u / f).toFixed(d));
    const entries = getCatalog(actor).map(e => {
      const auto = A.getPrice(e.itemData), unit = entryPrice(e, shop);
      return {
        id: e.id, name: e.itemData.name, img: e.icon || e.itemData.img, hasIcon: !!e.icon, unlimited: !!e.unlimited, stock: e.stock ?? 0,
        basePrice: dec(e.basePrice), baseHint: auto === null ? "sem preço" : dec(auto), finalPrice: dec(e.finalPrice),
        playerPrice: unit === null ? "sem preço" : A.format(unit)
      };
    });
    let balance = "";
    if (shop.limitedMoney) { const b = A.getBalance(actor); balance = b === null ? "Saldo ilegível: verifique o adaptador" : `Saldo atual na ficha: ${A.format(b)}`; }
    return { shop, entries, ready: A.isConfigured(), step: 1 / f, balance, accent: safeColor(shop.color), placeholderLogo: actor.img };
  }

  _onRender() {
    this.element.style.setProperty("--lst-accent", safeColor(getShop(this.actor).color));
    const zone = this.element.querySelector(".lst-drop");
    if (!zone) return;
    zone.addEventListener("dragover", ev => { ev.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", async ev => {
      ev.preventDefault(); zone.classList.remove("over");
      let data; try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
      if (data?.type !== "Item" || !data.uuid) return ui.notifications.warn("Arraste um item do diretório, de um compêndio ou de um inventário.");
      const item = await fromUuid(data.uuid);
      if (item) await addToCatalog(this.actor, item);
    });
  }

  static async _onSubmit(event, form, formData) {
    const actor = this.actor, A = adapter(), f = A.factor?.() ?? 1;
    const d = foundry.utils.expandObject(formData.object), upd = {};
    const S = k => `flags.${ID}.shop.${k}`;
    const s = d.shop ?? {};
    const str = (v, n) => String(v ?? "").trim().slice(0, n);
    upd[S("enabled")] = !!s.enabled; upd[S("open")] = !!s.open;
    upd[S("name")] = str(s.name, 60); upd[S("description")] = str(s.description, 300);
    upd[S("logo")] = str(s.logo, 300); upd[S("banner")] = str(s.banner, 300); upd[S("color")] = safeColor(s.color);
    upd[S("buyMult")] = Math.max(0, num(s.buyMult, 1)); upd[S("sellMult")] = Math.max(0, num(s.sellMult, 0.5));
    upd[S("allowBuy")] = !!s.allowBuy; upd[S("allowSell")] = !!s.allowSell; upd[S("limitedMoney")] = !!s.limitedMoney;
    const money = v => { if (v === "" || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * f) : undefined; };
    for (const e of getCatalog(actor)) {
      const r = d.catalog?.[e.id]; if (!r) continue;
      const P = k => `flags.${ID}.catalog.${e.id}.${k}`;
      upd[P("unlimited")] = !!r.unlimited;
      upd[P("stock")] = Math.max(0, Math.trunc(num(r.stock, 0)));
      const b = money(r.basePrice), fp = money(r.finalPrice);
      if (b !== undefined) upd[P("basePrice")] = b;
      if (fp !== undefined) upd[P("finalPrice")] = fp;
    }
    await actor.update(upd);
  }

  static _onPickLogo() { pickImage(this.actor.flags?.[ID]?.shop?.logo ?? "", p => this.actor.update({ [`flags.${ID}.shop.logo`]: p })); }
  static _onPickBanner() { pickImage(this.actor.flags?.[ID]?.shop?.banner ?? "", p => this.actor.update({ [`flags.${ID}.shop.banner`]: p })); }
  static _onPickIcon(ev, t) { const id = t.dataset.id; pickImage("", p => this.actor.update({ [`flags.${ID}.catalog.${id}.icon`]: p })); }
  static _onResetIcon(ev, t) { return this.actor.update({ [`flags.${ID}.catalog.${t.dataset.id}.icon`]: "" }); }
  static async _onRemove(ev, t) {
    const ok = await DialogV2.confirm({ window: { title: "Remover produto" }, content: "<p>Remover este produto da loja? O item original não é afetado.</p>", rejectClose: false });
    if (ok) await this.actor.update({ [`flags.${ID}.catalog.-=${t.dataset.id}`]: null });
  }
  static async _onOpenShop() { const { TradeApp } = await import("./trade-app.js"); if (isMerchant(this.actor)) TradeApp.open(this.actor); else ui.notifications.warn("Ative o comércio primeiro."); }
  static async _onImportSheet() {
    if (!adapter().isConfigured()) return ui.notifications.warn("Configure o adaptador antes (moeda é obrigatória).");
    const ok = await DialogV2.confirm({ window: { title: "Importar itens da ficha" }, content: "<p>Todos os itens da ficha deste mercador entram na loja, na quantidade em que estão. A ficha não é alterada, e itens já importados são ignorados.</p>", rejectClose: false });
    if (!ok) return;
    const n = await importFromSheet(this.actor);
    ui.notifications.info(n ? `${n} item(ns) importado(s) da ficha.` : "Nenhum item novo na ficha para importar.");
  }
  static _onOpenSheet() { this.actor.sheet.render({ force: true }); }
  static async _onOpenAdapter() { const { AdapterConfig } = await import("./adapter-config.js"); new AdapterConfig().render({ force: true }); }
}
