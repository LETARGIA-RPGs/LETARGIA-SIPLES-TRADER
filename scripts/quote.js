import { adapter } from "./adapter.js";
import { getShop, getCatalog, isMerchant, entryPrice, sellPrice } from "./shop.js";

/** Cálculo único usado pela prévia (cliente) e pela transação (mestre). buy/sell: [{id, qty}] */
export function buildQuote({ merchant, buyer, buy, sell }) {
  const A = adapter(), shop = getShop(merchant), errors = [];
  const q = { errors, buyLines: [], sellLines: [], buyTotal: 0, sellTotal: 0, net: 0, buyerBalance: null, merchantBalance: null };
  const err = m => { if (!errors.includes(m)) errors.push(m); };
  const okQty = n => Number.isSafeInteger(n) && n >= 1 && n <= 9999;

  if (!isMerchant(merchant)) err("Este personagem não é um mercador ativo.");
  if (!shop.open) err("A loja está fechada.");
  if (!A.isConfigured()) err("O adaptador de inventário e moeda não está configurado. Avise o mestre.");
  if (!buyer) err("Nenhum personagem autorizado para negociar.");
  if (buy.length && !shop.allowBuy) err("O mercador não está vendendo no momento.");
  if (sell.length && !shop.allowSell) err("O mercador não está comprando itens no momento.");

  const cat = new Map(getCatalog(merchant).map(e => [e.id, e]));
  const seenB = new Set(), seenS = new Set();
  for (const { id, qty } of buy) {
    if (typeof id !== "string" || seenB.has(id)) { err("Seleção de compra inválida."); continue; }
    seenB.add(id);
    const e = cat.get(id);
    if (!e) { err("Um produto não está mais à venda."); continue; }
    const name = e.itemData.name, unit = entryPrice(e, shop);
    const line = { id, qty, name, img: e.icon || e.itemData.img, unit, total: 0, entry: e };
    if (!okQty(qty)) err(`Quantidade inválida para "${name}".`);
    else {
      if (unit === null) err(`"${name}" está sem preço definido.`);
      else { line.total = unit * qty; q.buyTotal += line.total; }
      if (!e.unlimited && qty > e.stock) err(`Estoque insuficiente de "${name}" (restam ${e.stock}).`);
    }
    q.buyLines.push(line);
  }
  for (const { id, qty } of sell) {
    if (typeof id !== "string" || seenS.has(id)) { err("Seleção de venda inválida."); continue; }
    seenS.add(id);
    const item = buyer?.items.get(id);
    if (!item || !A.isTradable(item)) { err("Um item para vender não está mais disponível."); continue; }
    const owned = A.getQuantity(item), unit = sellPrice(item, shop);
    const line = { id, qty, name: item.name, img: item.img, unit, total: 0, item };
    if (!okQty(qty)) err(`Quantidade inválida para "${item.name}".`);
    else {
      if (unit === null) err(`"${item.name}" não tem valor de venda definido.`);
      else { line.total = unit * qty; q.sellTotal += line.total; }
      if (qty > owned) err(`Você só tem ${owned} de "${item.name}".`);
    }
    q.sellLines.push(line);
  }
  q.net = q.buyTotal - q.sellTotal;
  if (!Number.isSafeInteger(q.net)) err("Valores fora do limite permitido.");

  if (buyer && A.isConfigured()) {
    q.buyerBalance = A.getBalance(buyer);
    if (q.buyerBalance === null) err("Não foi possível ler o saldo do personagem (verifique o adaptador).");
    else if (q.net > 0 && q.buyerBalance < q.net) err("Dinheiro insuficiente.");
    if (shop.limitedMoney) {
      q.merchantBalance = A.getBalance(merchant);
      if (q.merchantBalance === null) err("Não foi possível ler o saldo do mercador.");
      else if (q.net < 0 && q.merchantBalance < -q.net) err("O mercador não tem dinheiro suficiente para esta compra.");
    }
  }
  return q;
}
