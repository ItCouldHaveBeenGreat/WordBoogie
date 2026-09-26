import { tileAppearance, reorderSelection } from './model.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Board and word tray deliberately use the same tile renderer and ownership styles.
export function renderTile(game, tile, { wordIndex = null, selectedIndex = -1, disabled = false } = {}) {
  const appearance = tileAppearance(game, tile);
  const inWord = wordIndex !== null;
  const position = inWord ? `word position ${wordIndex + 1}` : `row ${Math.floor(tile.id / game.boardSize) + 1}, column ${tile.id % game.boardSize + 1}`;
  const label = `${tile.letter}, ${position}, ${appearance.ownership}${appearance.defended ? ', protected' : ''}${!inWord && selectedIndex >= 0 ? `, selected position ${selectedIndex + 1}` : ''}`;
  return `<button type="button" class="tile ${appearance.colorClass} ${appearance.defended ? 'defended' : ''} ${inWord ? 'word-tile' : ''} ${!inWord && selectedIndex >= 0 ? 'selected' : ''}" ${inWord ? `data-word-tile="${tile.id}" draggable="false" aria-describedby="word-reorder-help"` : `data-tile="${tile.id}" data-index="${tile.id}" aria-pressed="${selectedIndex >= 0}"`} aria-label="${escape(label)}" ${disabled ? 'disabled' : ''}><span class="tile-letter">${tile.letter}</span>${appearance.marker ? `<span class="owner-marker" aria-hidden="true">${appearance.marker}</span>` : ''}${appearance.defended ? '<span class="protected" aria-hidden="true">◆</span>' : ''}${!inWord && selectedIndex >= 0 ? `<span class="order" aria-hidden="true">${selectedIndex + 1}</span>` : ''}</button>`;
}

export function renderWordComposer(game, selection, playable) {
  const word = selection.map(id => game.tiles[id].letter).join('');
  return `<div class="word-preview ${selection.length ? '' : 'empty'}"><div class="word-tiles" role="group" aria-label="Selected word tiles">${selection.length ? selection.map((id, wordIndex) => renderTile(game, game.tiles[id], { wordIndex, disabled: !playable })).join('') : playable ? 'Pick your letters. Anywhere on the board.' : 'Your next word is waiting.'}</div><span class="sr-only" aria-live="polite">${word || 'No letters selected'}</span></div>${selection.length ? '<p id="word-reorder-help" class="word-reorder-help">Drag tiles to reorder · Alt + ← / → with keyboard</p>' : ''}`;
}

export function bindWordComposer(root, { selection, onChange }) {
  const buttons = [...root.querySelectorAll('[data-word-tile]')];
  const container = root.querySelector('.word-tiles');
  if (!container) return () => {};
  let drag = null;
  let ghost = null, frame = 0;
  const targetAt = (x, y) => {
    const target = document.elementFromPoint(x, y)?.closest('[data-word-tile]');
    return target && container.contains(target) ? Number(target.dataset.wordTile) : null;
  };
  const clean = () => {
    cancelAnimationFrame(frame); frame = 0;
    ghost?.remove(); ghost = null;
    for (const button of buttons) button.classList.remove('dragging', 'drop-target');
    drag = null;
  };
  for (const button of buttons) {
    const id = Number(button.dataset.wordTile);
    button.addEventListener('pointerdown', event => {
      if (button.disabled || event.button !== 0 || !event.isPrimary) return;
      const rect = button.getBoundingClientRect();
      drag = { id, x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width, height: rect.height, moved: false, target: null };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (!drag || drag.id !== id) return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5 && !drag.moved) return;
      drag.moved = true;
      if (!ghost) {
        ghost = button.cloneNode(true);
        ghost.removeAttribute('data-word-tile'); ghost.removeAttribute('aria-describedby');
        ghost.setAttribute('aria-hidden', 'true'); ghost.tabIndex = -1;
        ghost.classList.add('drag-ghost');
        ghost.style.width = `${drag.width}px`; ghost.style.height = `${drag.height}px`;
        ghost.style.transform = `translate3d(${event.clientX - drag.offsetX}px,${event.clientY - drag.offsetY}px,0)`;
        document.body.append(ghost);
      }
      drag.clientX = event.clientX; drag.clientY = event.clientY;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (ghost && drag) ghost.style.transform = `translate3d(${drag.clientX - drag.offsetX}px,${drag.clientY - drag.offsetY}px,0)`;
      });
      drag.target = targetAt(event.clientX, event.clientY);
      button.classList.add('dragging');
      for (const other of buttons) other.classList.toggle('drop-target', drag.target === Number(other.dataset.wordTile) && other !== button);
    });
    button.addEventListener('pointerup', event => {
      if (!drag || drag.id !== id) return;
      const { moved } = drag;
      const target = targetAt(event.clientX, event.clientY);
      clean();
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      if (moved && target !== null && target !== id) onChange(reorderSelection(selection, selection.indexOf(id), selection.indexOf(target)), id);
    });
    button.addEventListener('pointercancel', clean);
    button.addEventListener('lostpointercapture', clean);
    button.addEventListener('keydown', event => {
      const index = selection.indexOf(id);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const to = Math.max(0, Math.min(selection.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
        if (event.altKey) onChange(reorderSelection(selection, index, to), id);
        else buttons[to]?.focus();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const next = selection.filter(value => value !== id);
        onChange(next, next[Math.min(index, next.length - 1)]);
      }
    });
  }
  return clean;
}
