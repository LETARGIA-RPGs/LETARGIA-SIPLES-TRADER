import { ID, TPL } from "../constants.js";
import { Generic, diagnose } from "../adapter.js";
import { isMerchant } from "../shop.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class AdapterConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "lst-adapter-config", classes: ["lst-app", "lst-config"], tag: "form",
    window: { title: "Adaptador genérico de inventário e moeda", icon: "fa-solid fa-coins", resizable: true },
    position: { width: 560, height: "auto" },
    form: { handler: AdapterConfig._onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: { diagnose: AdapterConfig._onDiagnose }
  };
  static PARTS = { main: { template: TPL("adapter-config.hbs") } };
  results = null; diagActor = "";

  async _prepareContext() {
    const c = Generic.config();
    const actors = game.actors.filter(a => !isMerchant(a)).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")).map(a => ({ id: a.id, name: a.name, selected: a.id === this.diagActor }));
    return { c, actors, results: this.results };
  }

  static async _save(formData) {
    const d = formData.object, c = Generic.config();
    const dec = Math.min(4, Math.max(0, Math.trunc(Number(d.decimals) || 0)));
    const next = {
      currencyPath: String(d.currencyPath ?? "").trim(), quantityPath: String(d.quantityPath ?? "").trim(), pricePath: String(d.pricePath ?? "").trim(),
      currencyName: String(d.currencyName ?? "").trim().slice(0, 30) || c.currencyName, currencySymbol: String(d.currencySymbol ?? "").trim().slice(0, 10),
      decimals: dec, eligibleTypes: String(d.eligibleTypes ?? "").trim()
    };
    await game.settings.set(ID, "generic", next);
  }
  static async _onSubmit(event, form, formData) { await AdapterConfig._save(formData); ui.notifications.info("Adaptador salvo."); this.results = diagnose(game.actors.get(this.diagActor) ?? null); this.render(); }
  static async _onDiagnose() {
    const fd = new foundry.applications.ux.FormDataExtended(this.element);
    await AdapterConfig._save(fd);
    this.diagActor = fd.object.diagActor ?? "";
    this.results = diagnose(game.actors.get(this.diagActor) ?? null);
    this.render();
  }
}
