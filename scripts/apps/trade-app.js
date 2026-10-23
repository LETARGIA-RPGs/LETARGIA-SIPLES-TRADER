import { ID, TPL, DEFAULT_LOGO } from "../constants.js";
import { adapter } from "../adapter.js";
import { getShop, getCatalog, isMerchant, merchantName, eligibleBuyers, entryPrice, sellPrice } from "../shop.js";
import { buildQuote } from "../quote.js";
import { requestTrade } from "../transaction.js";
import { hasGM, safeColor } from "../util.js";
import { MerchantConfig } from "./merchant-config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class TradeApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #all = new Map();
  static DEFAULT_OPTIONS = {
    classes: ["lst-app"],
    window: { title: "Loja", icon: "fa-solid fa-store", resizable: true },
    position: { width: 1020, height: 660 },
    actions: {
      addBuy: TradeApp._onAdd, addSell: TradeApp._onAdd, inc: TradeApp._onInc, dec: TradeApp._onDec, remove: TradeApp._onRemove,
      clear: TradeApp._onClear, confirm: TradeApp._onConfirm, openConfig: TradeApp._onOpenConfig, openSheet: TradeApp._onOpenSheet
    }
  };
  static PARTS = { main: { template: TPL("trade.hbs") } };

  buy = new Map(); sell = new Map();
  search = { me: "", shop: "" };
  busy = false; notice = ""; noticeKind = "info"; scroll = {}; buyerId = null;

  constructor(merchantId, options = {}) { super({ id: `lst-trade-${merchantId}`, ...options }); this.merchantId = merchantId; }
  get title() { const m = game.actors.get(this.merchantId); return m ? merchantName(m) : "Loja"; }

  static open(merchant) {
    let app = TradeApp.#all.get(merchant.id);
    if (!app) { app = new TradeApp(merchant.id); TradeApp.#all.set(merchant.id, app); }
    app.render({ force: true });
    return app;
  }
  static refreshAll() { for (const a of TradeApp.#all.values()) if (a.rendered && !a.busy) a.render(); }
  async _onClose(options) { TradeApp.#all.delete(this.merchantId); return super._onClose(options); }

  _setNotice(text, kind = "info") { this.notice = text; this.noticeKind = kind; }
  _add(side, id, delta) {
    const map = this[side], n = (map.get(id) ?? 0) + delta;
    if (n <= 0) map.delete(id); else map.set(id, n);
    this._setNotice(""); this.render();
  }
  static _onAdd(ev, t) { this._add(t.dataset.side, t.dataset.id, 1); }
  static _onInc(ev, t) { this._add(t.dataset.side, t.dataset.id, 1); }
  static _onDec(ev, t) { this._add(t.dataset.side, t.dataset.id, -1); }
  static _onRemove(ev, t) { this[t.dataset.side].delete(t.dataset.id); this._setNotice(""); this.render(); }
  static _onClear() { this.buy.clear(); this.sell.clear(); this._setNotice(""); this.render(); }
  static _onOpenConfig() { const m = game.actors.get(this.merchantId); if (m && game.user.isGM) MerchantConfig.open(m); }
  static _onOpenSheet() { const m = game.actors.get(this.merchantId); if (m && game.user.isGM) m.sheet.render({ force: true }); }

  _captureScroll() { this.element?.querySelectorAll("[data-scroll]").forEach(e => (this.scroll[e.dataset.scroll] = e.scrollTop)); }

  async _prepareContext() {
    this._captureScroll();
    const merchant = game.actors.get(this.merchantId);
    if (!merchant || !isMerchant(merchant)) return { gone: true };
    const A = adapter(), shop = getShop(merchant), fmt = u => A.format(u);
    const buyers = eligibleBuyers(game.user);
    if (!buyers.some(a => a.id === this.buyerId)) { this.buyerId = buyers[0]?.id ?? null; this.buy.clear(); this.sell.clear(); }
    const buyer = game.actors.get(this.buyerId) ?? null;
    const ctx = {
      gone: false, noBuyer: !buyer, compact: game.settings.get(ID, "compact"), accent: safeColor(shop.color),
      notice: this.notice, noticeKind: this.noticeKind, search: this.search, isGM: game.user.isGM, busy: this.busy,
      shop: { name: merchantName(merchant), description: shop.description, logo: shop.logo || merchant.img || DEFAULT_LOGO, banner: shop.banner, open: shop.open, allowBuy: shop.allowBuy, allowSell: shop.allowSell }
    };
    if (!buyer) return ctx;

    // linhas do mercador
    const shopRows = getCatalog(merchant).map(e => {
      const unit = entryPrice(e, shop), soldOut = !e.unlimited && e.stock < 1;
      const reason = !shop.allowBuy ? "O mercador não está vendendo" : soldOut ? "Estoque esgotado" : unit === null ? "Sem preço definido" : "";
      const cur = this.buy.get(e.id) ?? 0;
      if (cur && (reason || (!e.unlimited && cur > e.stock))) { if (reason) this.buy.delete(e.id); else this.buy.set(e.id, e.stock); }
      return { id: e.id, name: e.itemData.name, lname: e.itemData.name.toLowerCase(), img: e.icon || e.itemData.img, stockText: e.unlimited ? "Sempre disponível" : soldOut ? "Esgotado" : `${e.stock} em estoque`, price: unit === null ? "—" : fmt(unit), inCart: this.buy.get(e.id) ?? 0, blocked: !!reason, reason };
    });
    // linhas do jogador
    const myRows = A.listTradable(buyer).map(i => {
      const unit = sellPrice(i, shop), owned = A.getQuantity(i);
      const reason = !shop.allowSell ? "O mercador não está comprando" : unit === null ? "Sem valor de venda" : "";
      const cur = this.sell.get(i.id) ?? 0;
      if (cur && reason) this.sell.delete(i.id); else if (cur > owned) this.sell.set(i.id, owned);
      return { id: i.id, name: i.name, lname: i.name.toLowerCase(), img: i.img, qty: owned, price: unit === null ? "—" : fmt(unit), inCart: this.sell.get(i.id) ?? 0, blocked: !!reason, reason };
    });
    for (const id of [...this.sell.keys()]) if (!myRows.some(r => r.id === id)) this.sell.delete(id);
    for (const id of [...this.buy.keys()]) if (!shopRows.some(r => r.id === id)) this.buy.delete(id);

    const toArr = m => [...m].map(([id, qty]) => ({ id, qty }));
    const q = buildQuote({ merchant, buyer, buy: toArr(this.buy), sell: toArr(this.sell) });
    const gmOnline = hasGM(), lines = q.buyLines.length + q.sellLines.length;
    const show = l => ({ id: l.id, name: l.name, img: l.img, qty: l.qty, total: fmt(l.total) });
    return Object.assign(ctx, {
      buyers: buyers.map(a => ({ id: a.id, name: a.name, selected: a.id === this.buyerId })), multipleBuyers: buyers.length > 1,
      buyer: { name: buyer.name, img: buyer.img || "icons/svg/mystery-man.svg" },
      shopRows, myRows,
      buyLines: q.buyLines.map(show), sellLines: q.sellLines.map(show), hasLines: lines > 0,
      mode: !lines ? "Escolha o que comprar ou vender" : q.buyLines.length && q.sellLines.length ? "Você está comprando e vendendo" : q.buyLines.length ? "Você está comprando" : "Você está vendendo",
      wallet: { me: q.buyerBalance === null ? "—" : fmt(q.buyerBalance), merchant: shop.limitedMoney && q.merchantBalance !== null ? fmt(q.merchantBalance) : "" },
      totals: { buy: fmt(q.buyTotal), sell: fmt(q.sellTotal), netLabel: q.net > 0 ? "Você paga" : q.net < 0 ? "Você recebe" : "Diferença", net: fmt(Math.abs(q.net)), netClass: q.net > 0 ? "pay" : q.net < 0 ? "get" : "" },
      errors: lines ? q.errors : q.errors.filter(e => !/Nada selecionado/.test(e)),
      gmOnline, canConfirm: !this.busy && gmOnline && lines > 0 && q.errors.length === 0, _q: null
    });
  }

  _onRender() {
    const el = this.element;
    el.style.setProperty("--lst-accent", safeColor(getShop(game.actors.get(this.merchantId)).color));
    el.querySelectorAll("[data-scroll]").forEach(e => (e.scrollTop = this.scroll[e.dataset.scroll] ?? 0));
    el.querySelectorAll(".lst-search").forEach(inp => {
      inp.addEventListener("input", () => { this.search[inp.dataset.list] = inp.value; this._filter(inp.dataset.list); });
      this._filter(inp.dataset.list);
    });
    el.querySelector(".lst-buyer")?.addEventListener("change", ev => { this.buyerId = ev.target.value; this.buy.clear(); this.sell.clear(); this._setNotice(""); this.render(); });
    el.querySelectorAll(".lst-row[data-id]").forEach(r => {
      r.addEventListener("contextmenu", ev => { ev.preventDefault(); this._add(r.dataset.side, r.dataset.id, -1); });
      r.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); r.click(); } });
    });
  }
  _filter(list) {
    const q = (this.search[list] ?? "").trim().toLowerCase();
    this.element.querySelectorAll(`.lst-row[data-list="${list}"]`).forEach(r => (r.hidden = !!q && !r.dataset.name.includes(q)));
  }

  static async _onConfirm() {
    if (this.busy) return;
    const merchant = game.actors.get(this.merchantId), buyer = game.actors.get(this.buyerId);
    if (!merchant || !buyer) return;
    if (!hasGM()) { this._setNotice("O comércio exige um mestre conectado.", "bad"); return this.render(); }
    const toArr = m => [...m].map(([id, qty]) => ({ id, qty }));
    const buy = toArr(this.buy), sell = toArr(this.sell);
    const q = buildQuote({ merchant, buyer, buy, sell });
    if (q.errors.length || buy.length + sell.length === 0) { this._setNotice(q.errors[0] ?? "Nada selecionado.", "bad"); return this.render(); }
    this.busy = true; this._setNotice("Aguardando o mestre…"); this.render();
    let result;
    try { result = await requestTrade({ merchantId: merchant.id, buyerId: buyer.id, buy, sell, expected: { buy: q.buyTotal, sell: q.sellTotal } }); }
    catch (e) { console.error(e); result = { status: "failed", message: "Erro ao enviar a solicitação." }; }
    this.busy = false;
    if (result.status === "ok") { this.buy.clear(); this.sell.clear(); this._setNotice(result.message, "ok"); ui.notifications.info(result.message); }
    else this._setNotice(result.message ?? "Não foi possível concluir a troca.", result.status === "changed" ? "warn" : "bad");
    this.render();
  }
}
