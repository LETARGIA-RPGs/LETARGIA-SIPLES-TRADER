import { ID, SOCKET } from "./constants.js";
import { Generic, registerAdapter } from "./adapter.js";
import { isMerchant, getShop, setMerchantActive, DEFAULT_SHOP } from "./shop.js";
import { onSocket } from "./transaction.js";
import { esc } from "./util.js";
import { TradeApp } from "./apps/trade-app.js";
import { MerchantConfig } from "./apps/merchant-config.js";
import { AdapterConfig } from "./apps/adapter-config.js";

const actorOf = li => { const el = li instanceof HTMLElement ? li : li?.[0]; return game.actors.get(el?.dataset?.entryId ?? el?.dataset?.documentId); };

function openShop(actor) {
  if (!actor || !isMerchant(actor)) return;
  if (!getShop(actor).open && !game.user.isGM) return ui.notifications.warn("A loja está fechada no momento.");
  TradeApp.open(actor);
}
async function activate(actor) {
  await setMerchantActive(actor, true);
  ui.notifications.info(`${actor.name} agora é um mercador. Arraste itens para a configuração.`);
  MerchantConfig.open(actor);
}
async function createMerchant() {
  const types = Actor.TYPES.filter(t => t !== "base");
  const opts = types.map(t => `<option value="${esc(t)}">${esc(game.i18n.localize(CONFIG.Actor.typeLabels?.[t] ?? t))}</option>`).join("");
  const content = `<div class="form-group"><label>Nome</label><input name="name" type="text" value="Novo mercador"></div><div class="form-group"><label>Tipo de ator</label><select name="type">${opts}</select></div>`;
  const res = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Criar mercador" }, content, rejectClose: false,
    ok: { label: "Criar", callback: (ev, btn) => ({ name: btn.form.elements.name.value.trim() || "Mercador", type: btn.form.elements.type.value }) }
  });
  if (!res) return;
  const actor = await Actor.create({ name: res.name, type: res.type, ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED }, flags: { [ID]: { shop: { ...DEFAULT_SHOP, enabled: true, name: res.name } } } });
  if (actor) MerchantConfig.open(actor);
}

Hooks.once("init", () => {
  game.settings.register(ID, "generic", { scope: "world", config: false, type: Object, default: { ...Generic.defaults } });
  game.settings.register(ID, "adapterId", { scope: "world", config: false, type: String, default: "generic" });
  game.settings.register(ID, "compact", { name: "Cartões compactos na loja", hint: "Reduz o tamanho dos itens (apenas para você).", scope: "client", config: true, type: Boolean, default: false, onChange: () => TradeApp.refreshAll() });
  game.settings.registerMenu(ID, "adapterMenu", { name: "Adaptador genérico de inventário e moeda", label: "Configurar adaptador", hint: "Caminhos dos campos de moeda, quantidade e preço do seu sistema, com diagnóstico.", icon: "fa-solid fa-coins", type: AdapterConfig, restricted: true });
  game.modules.get(ID).api = { openShop, activate, createMerchant, registerAdapter, TradeApp, MerchantConfig };
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);

  // Duplo clique: só desvia tokens de mercadores ativos; todo o resto segue o comportamento original.
  const proto = CONFIG.Token.objectClass?.prototype;
  if (proto && !proto._lstPatched) {
    const orig = proto._onClickLeft2;
    proto._onClickLeft2 = function (event, ...rest) {
      try {
        const actor = this.document?.actorId ? game.actors.get(this.document.actorId) : null;
        const shift = event?.shiftKey ?? event?.nativeEvent?.shiftKey;
        if (actor && isMerchant(actor) && !(game.user.isGM && shift)) return openShop(actor);   // mestre: Shift+duplo clique abre a ficha
      } catch (e) { console.error(`${ID} |`, e); }
      return orig?.call(this, event, ...rest);
    };
    proto._lstPatched = true;
  }
});

// Atualização por eventos (sem polling)
const refresh = foundry.utils.debounce(() => { TradeApp.refreshAll(); MerchantConfig.refreshAll(); }, 150);
for (const h of ["updateActor", "createItem", "updateItem", "deleteItem", "updateUser", "userConnected"]) Hooks.on(h, refresh);

// Botão "Criar mercador" no diretório de atores
Hooks.on("renderActorDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const el = html instanceof HTMLElement ? html : html[0];
  if (!el || el.querySelector(".lst-create")) return;
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "lst-create";
  btn.innerHTML = '<i class="fa-solid fa-store"></i> Criar mercador';
  btn.addEventListener("click", createMerchant);
  (el.querySelector(".header-actions") ?? el.querySelector(".directory-header") ?? el).append(btn);
});

// Menu de contexto do diretório (nome do hook mudou entre versões; ambos registrados)
const ctxOptions = (app, options) => {
  if (!Array.isArray(options)) return;
  options.push(
    { name: "Ativar como mercador", icon: '<i class="fa-solid fa-store"></i>', condition: li => game.user.isGM && !isMerchant(actorOf(li)), callback: li => activate(actorOf(li)) },
    { name: "Configurar mercador", icon: '<i class="fa-solid fa-gear"></i>', condition: li => game.user.isGM && isMerchant(actorOf(li)), callback: li => MerchantConfig.open(actorOf(li)) },
    { name: "Abrir loja", icon: '<i class="fa-solid fa-shop"></i>', condition: li => isMerchant(actorOf(li)), callback: li => openShop(actorOf(li)) }
  );
};
Hooks.on("getActorContextOptions", ctxOptions);
Hooks.on("getActorDirectoryEntryContext", (html, options) => ctxOptions(null, options));

// Botão no cabeçalho das fichas de ator (V2 e legadas)
function sheetButton(app, root) {
  const actor = app.document ?? app.actor;
  if (!game.user.isGM || actor?.documentName !== "Actor" || !root) return;
  const header = root.querySelector(".window-header");
  if (!header || header.querySelector(".lst-hdr")) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "header-control icon fa-solid fa-store lst-hdr";
  b.dataset.tooltip = isMerchant(actor) ? "Configurar mercador" : "Ativar como mercador";
  b.addEventListener("click", ev => { ev.preventDefault(); isMerchant(actor) ? MerchantConfig.open(actor) : activate(actor); });
  (header.querySelector(".window-title") ?? header.firstElementChild)?.after(b);
}
Hooks.on("renderApplicationV2", (app, el) => sheetButton(app, el));
Hooks.on("renderActorSheet", (app, html) => sheetButton(app, (html instanceof HTMLElement ? html : html?.[0])?.closest?.(".window-app") ?? app.element?.[0]));
