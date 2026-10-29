// Race Now toys. The sticky flag is a product scoring rule, not an anti-tamper boundary.
export const quickRaceCheatsAllowed = (opts = {}) => opts.quickRace === true && !opts.net && !opts.spectate;
export const withQuickRaceCheats = (opts, mode) => ({ ...opts, quickRace: mode === 'quick' && !opts.net && !opts.spectate });
export const canSubmitRaceScore = res => res?.status === 'finished' && Number.isFinite(res.time) && res.time > 0 && !res.usedCheats;
const names = {
  ungh: ['Veldaar', 'Nuügi', 'Loki', 'Lars', 'Knrph', 'Jörgi'],
  jaratae: ['Honest Phil', 'Tamil Vistini', 'Magenta', 'Kinsel Andara', 'Ryder Zanta Storm', 'Vida'],
};
export const cheatChoices = [
  ['nitro', 'Refill nitro', 'SPOON!'], ['chain', 'Get chain', 'THWACK!'], ['club', 'Get club', "K’THUNK!"],
  ['police', 'Dismiss police', 'End the current pursuit'], ['ungh', 'UNGH! rider names', 'UNGH!'],
  ['jaratae', 'JARATAE rider names', 'JARATAE'], ['riffraff', 'Course rider names', 'RIFFRAFF'], ['original', 'Restore rider names', ''],
];
const codes = { 'SPOON!': 'nitro', 'THWACK!': 'chain', "K'THUNK!": 'club', 'UNGH!': 'ungh', JARATAE: 'jaratae', RIFFRAFF: 'riffraff' };
export function createQuickRaceCheats({ opts, player, rivals, canUse = () => true, dismissPolice = () => {}, onUse = () => {} }) {
  if (!quickRaceCheatsAllowed(opts)) return null;
  const original = rivals.map(r => r.name);
  let used = false;
  return {
    get used() { return used; },
    get ready() { return canUse(); },
    get hasCourseNames() { return !!opts.cheatNames?.length; },
    code(text) { return this.run(codes[String(text).trim().toUpperCase().replace(/[’‘]/g, "'")]); },
    run(id) {
      if (!canUse()) return false;
      let message;
      if (id === 'nitro') {
        const nitro = { a: 256, b: 384, c: 240, d: 10, e: 120, f: 15 };
        player.bike = { ...player.bike, nitro, ...(player.bike.spec && { spec: { ...player.bike.spec, nitro } }) };
        player.nitros = 10; player.nitroT = 0; message = 'Nitro ready: 10 charges';
      } else if (id === 'chain' || id === 'club') {
        player.weapon = id; message = id === 'chain' ? 'Chain equipped' : 'Club equipped';
      } else if (id === 'police') {
        dismissPolice(); message = 'Current police pursuit dismissed';
      } else {
        const list = id === 'original' ? original : id === 'riffraff' ? opts.cheatNames : Object.hasOwn(names, id || '') ? names[id] : null;
        if (!list?.length) return false;
        rivals.forEach((r, i) => { r.name = list[i % list.length] || original[i]; });
        message = 'Rider names updated';
      }
      used = true; onUse(message, id); return message;
    },
  };
}

export function mountQuickRaceCheats({ container, pausePanel, cheats, onOpen, onClose }) {
  if (!cheats) return null;
  const doc = container.ownerDocument;
  const entry = doc.createElement('button'); entry.type = 'button'; entry.className = 'cheats-entry touch-control'; entry.textContent = 'CHEATS';
  entry.setAttribute('aria-haspopup', 'dialog'); entry.setAttribute('aria-expanded', 'false');
  pausePanel.insertBefore(entry, pausePanel.querySelector('.quit'));
  const badge = doc.createElement('div'); badge.className = 'cheats-badge'; badge.textContent = 'CHEATS USED · UNSCORED'; badge.hidden = true;
  const layer = doc.createElement('div'); layer.className = 'cheats-layer touch-control'; layer.hidden = true;
  layer.innerHTML = `<section class="cheats-dialog" role="dialog" aria-modal="true" aria-label="Race Now cheats" tabindex="-1"><h2>Cheats</h2><p>Race Now only. Using any cheat makes this race unscored.</p><div class="cheats-list">${cheatChoices.map(([id, label, code]) => `<button type="button" data-cheat="${id}">${label}<small>${code}</small></button>`).join('')}</div><form><label for="race-cheat-code">Enter a cheat code</label><div class="cheats-code"><input id="race-cheat-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="SPOON!"><button type="submit">Apply</button></div></form><p class="cheats-status" role="status" aria-live="polite"></p><button type="button" class="cheats-back">Back to pause menu</button></section>`;
  container.append(badge, layer);
  const dialog = layer.querySelector('section'), status = layer.querySelector('[role=status]'), input = layer.querySelector('input');
  const buttons = [...layer.querySelectorAll('[data-cheat]')];
  buttons.find(b => b.dataset.cheat === 'riffraff').disabled = !cheats.hasCourseNames;
  let open = false;
  const close = () => { if (!open) return; open = false; layer.hidden = true; entry.setAttribute('aria-expanded', 'false'); onClose(); entry.focus(); };
  const report = message => { status.textContent = message || 'Code not recognised. Try SPOON! or choose a cheat above.'; badge.hidden = !cheats.used; };
  entry.onclick = () => {
    if (!cheats.ready) return;
    onOpen(); open = true; layer.hidden = false; entry.setAttribute('aria-expanded', 'true'); buttons[0].focus();
  };
  layer.querySelector('.cheats-back').onclick = close;
  for (const button of buttons) button.onclick = () => report(cheats.run(button.dataset.cheat));
  layer.querySelector('form').onsubmit = e => { e.preventDefault(); report(cheats.code(input.value)); input.value = ''; };
  layer.addEventListener('pointerdown', e => e.stopPropagation());
  const keydown = e => {
    if (!open) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input')];
    const index = controls.indexOf(doc.activeElement);
    if (e.key === 'Tab' || (e.target !== input && ['ArrowUp', 'ArrowDown'].includes(e.key))) {
      e.preventDefault(); const backwards = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey);
      controls[(index + (backwards ? -1 : 1) + controls.length) % controls.length].focus();
    }
  };
  doc.defaultView.addEventListener('keydown', keydown, true);
  return { get isOpen() { return open; }, dispose() { doc.defaultView.removeEventListener('keydown', keydown, true); entry.remove(); badge.remove(); layer.remove(); } };
}
