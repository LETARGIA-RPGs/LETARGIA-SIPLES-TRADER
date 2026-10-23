import { ID, SOCKET } from "./constants.js";
import { adapter } from "./adapter.js";
import { getShop, getCatalog, isMerchant, merchantName } from "./shop.js";
import { buildQuote } from "./quote.js";
import { esc, uid, electedGM, hasGM } from "./util.js";

/* ===================== LADO DO MESTRE ===================== */
const results = new Map();            // "userId:requestId" -> {ts, promise, result}
let tail = Promise.resolve();         // fila global: uma transação por vez
const enqueue = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };

export function processRequest(user, msg) {
  if (typeof msg?.requestId !== "string" || msg.requestId.length > 40) return Promise.resolve({ status: "error", message: "Solicitação inválida." });
  const key = `${user.id}:${msg.requestId}`;
  const hit = results.get(key);
  if (hit) return hit.promise;                       // reprocessamento: devolve o mesmo resultado
  const rec = { ts: Date.now(), result: null };
  rec.promise = enqueue(async () => {
    try { return await execute(user, msg); }
    catch (e) { console.error(`${ID} | erro inesperado`, e); return { status: "failed", message: "Erro interno ao processar a troca. Confira os inventários e avise o mestre." }; }
  }).then(r => (rec.result = r));
  results.set(key, rec);
  for (const [k, v] of results) if (Date.now() - v.ts > 30 * 60 * 1000) results.delete(k);
  return rec.promise;
}
export function lookup(user, requestId) {
  const r = results.get(`${user.id}:${requestId}`);
  return !r ? { status: "unknown" } : r.result ?? { status: "pending" };
}

async function runSteps(steps) {
  const done = [];
  try { for (const s of steps) { await s.run(); done.push(s); } return { ok: true }; }
  catch (error) {
    console.error(`${ID} | falha na etapa, revertendo`, error);
    const failed = [];
    for (const s of done.reverse()) { try { await s.undo(); } catch (e) { console.error(e); failed.push(s.label); } }
    return { ok: false, error, failed };
  }
}

async function execute(user, msg) {
  const A = adapter();
  const { merchantId, buyerId, buy, sell, expected } = msg;
  const valid = a => Array.isArray(a) && a.length <= 100 && a.every(l => l && typeof l.id === "string" && typeof l.qty === "number");
  if (typeof merchantId !== "string" || typeof buyerId !== "string" || !valid(buy) || !valid(sell) || buy.length + sell.length === 0)
    return { status: "error", message: "Solicitação inválida." };
  const merchant = game.actors.get(merchantId), buyer = game.actors.get(buyerId);
  if (!merchant || !isMerchant(merchant)) return { status: "error", message: "Mercador indisponível." };
  if (!buyer || isMerchant(buyer) || !buyer.testUserPermission(user, "OWNER")) return { status: "error", message: "Você não tem autorização para negociar com este personagem." };

  const clean = a => a.map(l => ({ id: l.id, qty: l.qty }));
  const q = buildQuote({ merchant, buyer, buy: clean(buy), sell: clean(sell) });
  if (expected?.buy !== q.buyTotal || expected?.sell !== q.sellTotal)
    return { status: "changed", message: "Preços ou estoque mudaram. Revise o resumo e confirme novamente." };
  if (q.errors.length) return { status: "error", message: q.errors[0], errors: q.errors };

  const shop = getShop(merchant);
  const steps = [];

  // 1) dinheiro (apenas o valor líquido)
  if (q.net !== 0) {
    const prev = q.buyerBalance;
    steps.push({ label: "saldo do comprador", run: () => A.setBalance(buyer, prev - q.net), undo: () => A.setBalance(buyer, prev) });
    if (shop.limitedMoney) {
      const mp = q.merchantBalance;
      steps.push({ label: "saldo do mercador", run: () => A.setBalance(merchant, mp + q.net), undo: () => A.setBalance(merchant, mp) });
    }
  }

  // 2) inventário do comprador
  const finalQty = new Map();
  for (const l of q.sellLines) finalQty.set(l.item.id, (finalQty.get(l.item.id) ?? A.getQuantity(l.item)) - l.qty);
  const creates = [];
  for (const l of q.buyLines) {
    const data = l.entry.itemData;
    const target = A.hasQuantity() ? buyer.items.find(i => A.canStack(i, data)) : null;
    if (target) { finalQty.set(target.id, (finalQty.get(target.id) ?? A.getQuantity(target)) + l.qty); continue; }
    const planned = A.hasQuantity() ? creates.find(c => A.canStack(c.data, data)) : null;
    if (planned) planned.qty += l.qty; else creates.push({ data, qty: l.qty });
  }
  const updates = [], deletes = [];
  for (const [id, qty] of finalQty) {
    if (qty <= 0) deletes.push(id);
    else if (qty !== A.getQuantity(buyer.items.get(id))) updates.push({ id, qty });
  }
  if (updates.length) {
    const prev = updates.map(u => ({ id: u.id, qty: A.getQuantity(buyer.items.get(u.id)) }));
    steps.push({ label: "quantidades do inventário", run: () => A.setQuantities(buyer, updates), undo: () => A.setQuantities(buyer, prev) });
  }
  if (creates.length) {
    let made = [];
    steps.push({
      label: "novos itens",
      run: async () => { const docs = creates.flatMap(c => (A.hasQuantity() ? [A.prepare(c.data, c.qty)] : Array.from({ length: c.qty }, () => A.prepare(c.data, 1))));
        made = await A.createItems(buyer, docs); },
      undo: () => (made.length ? A.deleteItems(buyer, made.map(i => i.id)) : null)
    });
  }
  if (deletes.length) {
    const backup = deletes.map(id => buyer.items.get(id).toObject());
    steps.push({ label: "itens esgotados", run: () => A.deleteItems(buyer, deletes), undo: () => A.restoreItems(buyer, backup) });
  }

  // 3) estoque do mercador
  const catalog = getCatalog(merchant), stock = new Map(catalog.map(e => [e.id, e.stock ?? 0]));
  const patch = {}, undo = {}, fresh = [];
  const P = id => `flags.${ID}.catalog.${id}`;
  for (const l of q.buyLines) {
    if (l.entry.unlimited) continue;
    const n = stock.get(l.id) - l.qty; stock.set(l.id, n);
    patch[`${P(l.id)}.stock`] = n; undo[`${P(l.id)}.stock`] = l.entry.stock;
  }
  for (const l of q.sellLines) {
    const e = catalog.find(c => A.canStack(c.itemData, l.item));
    if (e) {
      if (e.unlimited) continue;
      const n = stock.get(e.id) + l.qty; stock.set(e.id, n);
      patch[`${P(e.id)}.stock`] = n; undo[`${P(e.id)}.stock`] = e.stock;
      continue;
    }
    const f = fresh.find(x => A.canStack(x.itemData, l.item));
    if (f) { f.stock += l.qty; continue; }
    const data = A.cleanData(l.item); A.setQty(data, 1);
    fresh.push({ id: uid(), itemData: data, stock: l.qty, unlimited: false, basePrice: A.getPrice(l.item), finalPrice: null, icon: "", order: Date.now() });
  }
  for (const f of fresh) { patch[P(f.id)] = f; undo[`flags.${ID}.catalog.-=${f.id}`] = null; }
  if (Object.keys(patch).length) steps.push({ label: "estoque do mercador", run: () => merchant.update(patch), undo: () => merchant.update(undo) });

  const res = await runSteps(steps);
  if (!res.ok) {
    const text = res.failed.length
      ? `FALHA CRÍTICA: a troca de ${buyer.name} com ${merchantName(merchant)} falhou e não foi possível reverter: ${res.failed.join(", ")}. Verifique manualmente.`
      : `A troca de ${buyer.name} com ${merchantName(merchant)} falhou e foi revertida (${res.error?.message ?? "erro"}).`;
    await whisperGMs(text);
    return { status: "failed", message: res.failed.length ? "A troca falhou e houve problema ao reverter. O mestre foi avisado; não repita a compra." : "A troca falhou e foi revertida. Nada foi cobrado." };
  }
  await receipt(user, merchant, buyer, q, A);
  const t = q.net > 0 ? `Você pagou ${A.format(q.net)}.` : q.net < 0 ? `Você recebeu ${A.format(-q.net)}.` : "Troca sem diferença de valor.";
  return { status: "ok", message: `Troca concluída. ${t}` };
}

async function whisperGMs(text) {
  try { await ChatMessage.create({ content: `<p>${esc(text)}</p>`, whisper: game.users.filter(u => u.isGM).map(u => u.id) }); }
  catch (e) { console.error(e); }
}
async function receipt(user, merchant, buyer, q, A) {
  try {
    const li = ls => ls.map(l => `<li>${l.qty}× ${esc(l.name)} — ${esc(A.format(l.total))}</li>`).join("");
    const net = q.net > 0 ? `Pago: ${A.format(q.net)}` : q.net < 0 ? `Recebido: ${A.format(-q.net)}` : "Sem diferença de valor";
    const content = `<div class="lst-receipt"><h3><i class="fa-solid fa-receipt"></i> ${esc(merchantName(merchant))}</h3><p><b>${esc(buyer.name)}</b></p>`
      + (q.buyLines.length ? `<p>Comprou</p><ul>${li(q.buyLines)}</ul>` : "")
      + (q.sellLines.length ? `<p>Vendeu</p><ul>${li(q.sellLines)}</ul>` : "")
      + `<p><b>${esc(net)}</b></p></div>`;
    const whisper = [...new Set([user.id, ...game.users.filter(u => u.isGM).map(u => u.id)])];
    await ChatMessage.create({ content, whisper, speaker: { alias: merchantName(merchant) } });
  } catch (e) { console.error(`${ID} | falha ao registrar recibo`, e); }
}

/* ===================== LADO DO CLIENTE ===================== */
const pending = new Map();

export async function requestTrade(payload) {
  if (!hasGM()) return { status: "nogm", message: "O comércio exige um mestre conectado." };
  const requestId = uid();
  const msg = { type: "request", requestId, ...payload };
  if (electedGM().id === game.user.id) return processRequest(game.user, msg);
  return new Promise(resolve => {
    const p = {};
    p.finish = r => { clearTimeout(p.t); pending.delete(requestId); resolve(r); };
    // Sem resposta: apenas CONSULTA o resultado da mesma solicitação; nunca reenvia a compra.
    p.t = setTimeout(() => {
      game.socket.emit(SOCKET, { type: "query", requestId });
      p.t = setTimeout(() => p.finish({ status: "unknown", message: "Não houve confirmação do mestre. Confira seu inventário e saldo antes de tentar de novo." }), 15000);
    }, 20000);
    pending.set(requestId, p);
    game.socket.emit(SOCKET, msg);
  });
}

const reply = (to, requestId, result) => game.socket.emit(SOCKET, { type: "result", requestId, to, result });

/** Recebe (data, senderId) do transporte do Foundry. senderId vem do servidor, nunca do conteúdo. */
export async function onSocket(data, senderId) {
  if (!data || typeof data !== "object") return;
  if (data.type === "result") {
    if (data.to !== game.user.id || !game.users.get(senderId)?.isGM) return;
    pending.get(data.requestId)?.finish(data.result);
    return;
  }
  if (!game.user.isGM || electedGM()?.id !== game.user.id) return;
  const sender = senderId ? game.users.get(senderId) : null;
  if (!sender?.active) return;                                      // identidade não verificável: ignora
  if (data.type === "request") reply(sender.id, data.requestId, await processRequest(sender, data));
  else if (data.type === "query") { const r = lookup(sender, data.requestId); if (r.status !== "pending") reply(sender.id, data.requestId, r); }
}
