export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const uid = () => foundry.utils.randomID(24);
export const safeColor = c => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c : "#c9a227");
export const num = (v, d) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));
export const activeGMs = () => game.users.filter(u => u.active && u.isGM).sort((a, b) => a.id.localeCompare(b.id));
export const electedGM = () => activeGMs()[0] ?? null;
export const hasGM = () => activeGMs().length > 0;
export function pickImage(current, callback) {
  const FP = foundry.applications.apps?.FilePicker?.implementation ?? FilePicker;
  new FP({ type: "image", current, callback }).render({ force: true });
}
