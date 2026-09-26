import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { createApp } from '../services/local/server.mjs';
import { chooseBotAction } from '../packages/engine/index.mjs';
import { createWebServer, listen } from './web-server.mjs';

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright'));
} catch {
  console.error('Browser tests need Playwright: npm install --no-save --package-lock=false playwright && npx playwright install chromium');
  process.exit(1);
}
const reservePort = async () => {
  const probe = createServer(); await listen(probe, 0);
  const port = probe.address().port;
  await new Promise(r => probe.close(r)); return port;
};
const directory = await mkdtemp(join(tmpdir(), 'wordboogie-browser-'));
const frontendPort = await reservePort();
const origin = `http://127.0.0.1:${frontendPort}`;
const app = createApp({ databasePath: join(directory, 'test.sqlite'), frontendOrigin: origin, botIntervalMs: 50, seed: 'browser-suite' });
await listen(app.server, 0);
const apiUrl = `http://127.0.0.1:${app.server.address().port}`;
const web = createWebServer({ apiUrl, frontendOrigin: origin });
await listen(web, frontendPort);
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  const rulePage = await context.newPage();
  await rulePage.goto(origin);
  await rulePage.locator('#display-name').fill('Rules tester');
  await rulePage.locator('[data-rule="permanentDefense"]').check();
  await rulePage.locator('[data-rule="exclusiveDefense"]').check();
  await rulePage.locator('[data-count="3"]').click();
  assert.ok(await rulePage.locator('[data-rule="permanentDefense"]').isChecked());
  assert.ok(await rulePage.locator('[data-rule="exclusiveDefense"]').isChecked());
  await rulePage.locator('#create-form').getByRole('button', { name: 'Create game' }).click();
  await rulePage.waitForSelector('[data-action="start"]');
  assert.match(await rulePage.locator('#app').innerText(), /Rules: Permanent Defense · Exclusive Defense/);
  await rulePage.reload();
  await rulePage.waitForSelector('[data-action="start"]');
  assert.match(await rulePage.locator('#app').innerText(), /Rules: Permanent Defense · Exclusive Defense/);
  await rulePage.close();
  await page.goto(origin);
  await page.locator('#display-name').fill('Ada');
  await page.locator('[data-count="4"]').click();
  await page.locator('[data-size="7"]').click();
  await page.locator('#create-form').getByRole('button', { name: 'Create game' }).click();
  await page.locator('[data-action="start"]').click();
  await page.waitForSelector('[data-tile="48"]');
  const wordBox = await page.locator('.word-tray').boundingBox();
  const boardBox = await page.locator('.board-wrap').boundingBox();
  assert.ok(wordBox.y + wordBox.height <= boardBox.y, 'Current word box must sit above the board');
  const colors = await page.locator('.score-card').evaluateAll(cards => cards.map(card => ({
    score: getComputedStyle(card.querySelector('.score')).backgroundColor,
    avatar: getComputedStyle(card.querySelector('.avatar')).backgroundColor
  })));
  assert.equal(new Set(colors.map(color => color.score)).size, 4, 'Each player needs a distinct score color');
  for (const color of colors) assert.equal(color.score, color.avatar, 'Score indicator matches the player color');
  const getGame = () => page.evaluate(async api => {
    const id = location.hash.split('/')[2];
    const saved = JSON.parse(localStorage.getItem('wordboogie.sessions'))[id];
    return (await (await fetch(`${api}/games/${id}`, { headers: { Authorization: `Bearer ${saved.token}` } })).json()).game;
  }, apiUrl);
  const before = await getGame();
  const action = chooseBotAction(before, () => 0.4);
  assert.equal(action.type, 'word');
  for (const id of action.tileIds) await page.locator(`[data-tile="${id}"]`).click();
  const composition = () => page.locator('[data-word-tile]').evaluateAll(tiles => tiles.map(tile => Number(tile.dataset.wordTile)));
  assert.deepEqual(await composition(), action.tileIds);
  const first = action.tileIds[0], last = action.tileIds.at(-1);
  const dragSource = await page.locator(`[data-word-tile="${first}"]`).boundingBox();
  const dragTarget = await page.locator(`[data-word-tile="${last}"]`).boundingBox();
  const pointer = { x: dragTarget.x + dragTarget.width / 2, y: dragTarget.y + dragTarget.height / 2 };
  await page.mouse.move(dragSource.x + dragSource.width / 2, dragSource.y + dragSource.height / 2);
  await page.mouse.down();
  await page.mouse.move(pointer.x, pointer.y, { steps: 8 });
  await page.waitForFunction(({ x, y }) => {
    const box = document.querySelector('.drag-ghost')?.getBoundingClientRect();
    return box && Math.abs(box.x + box.width / 2 - x) < 2 && Math.abs(box.y + box.height / 2 - y) < 2;
  }, pointer);
  await page.mouse.up();
  assert.equal(await page.locator('.drag-ghost').count(), 0);
  assert.deepEqual(await composition(), [...action.tileIds.slice(1), first], 'Dragging moves the tile to its new word position');
  // Keyboard alternative restores the selected word before submission.
  for (let i = 1; i < action.tileIds.length; i++) await page.locator(`[data-word-tile="${first}"]`).press('Alt+ArrowLeft');
  assert.deepEqual(await composition(), action.tileIds);
  // Accept a move but lose its response, then recover the exact request after reload.
  await page.route('**/games/*/actions', async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
  await page.locator('[data-action="submit"]').click();
  await page.getByRole('button', { name: 'Retry request' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Retry request' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.history li').length === 4 && !document.querySelector('[data-action="pass"]').disabled);
  const after = await getGame();
  assert.equal(after.history.length, 4);
  assert.deepEqual(after.history[0].tileIds, action.tileIds);
  assert.equal(after.history.filter(record => record.actor === before.seats[0].id).length, 1);
  await page.reload();
  await page.locator('.move-replay[data-replay-turn="4"]').waitFor();
  assert.match(await page.locator('.move-replay').innerText(), new RegExp(after.history.at(-1).word));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-tile]')].some(tile => tile.getAnimations().length > 0));
  await page.locator('.move-replay').waitFor({ state: 'detached' });
  const pollResponse = page.waitForResponse(response => response.url().includes('/games/') && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pollResponse;
  assert.equal(await page.locator('.move-replay').count(), 0, 'Unchanged polling must not replay the move');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload(); await page.locator('.move-replay').waitFor();
  assert.equal(await page.locator('[data-tile]').evaluateAll(tiles => tiles.reduce((sum, tile) => sum + tile.getAnimations().length, 0)), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const id of action.tileIds) await page.locator(`[data-tile="${id}"]`).click();
  await page.locator('[data-action="submit"]').click();
  await page.getByRole('alert').filter({ hasText: 'already been played' }).waitFor();
  assert.equal((await getGame()).history.length, 4);
  await page.locator('[data-action="clear"]').click();
  const sampleTiles = [...after.seats.map(seat => after.tiles.find(tile => tile.owner === seat.id)), after.tiles.find(tile => tile.owner === null)].filter(Boolean);
  for (const tile of sampleTiles) {
    await page.locator(`[data-tile="${tile.id}"]`).click();
    const boardColor = await page.locator(`[data-tile="${tile.id}"]`).evaluate(tile => getComputedStyle(tile).backgroundColor);
    const trayColor = await page.locator(`[data-word-tile="${tile.id}"]`).evaluate(tile => getComputedStyle(tile).backgroundColor);
    assert.equal(trayColor, boardColor, 'Word tiles keep their board ownership colors even when selected');
  }
  const compactBoard = await page.locator('.board-wrap').boundingBox();
  assert.ok(compactBoard.width >= 520 && compactBoard.width <= 530, 'Desktop board is about 15% smaller than 620px');
  assert.ok(await page.locator('[data-tile="0"]').evaluate(tile => parseFloat(getComputedStyle(tile).fontSize) >= 45), 'Desktop letters are larger');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 850 });
  const dimensions = await page.locator('[data-tile="0"]').boundingBox();
  assert.ok(dimensions.width >= 40 && dimensions.height >= 40, JSON.stringify(dimensions));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px viewport should not overflow');
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  const touchContext = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 320, height: 850 }, isMobile: true, hasTouch: true });
  const touch = await touchContext.newPage();
  await touch.goto(page.url());
  const touchIds = sampleTiles.slice(0, 3).map(tile => tile.id);
  for (const id of touchIds) await touch.locator(`[data-tile="${id}"]`).tap();
  const sourceBox = await touch.locator(`[data-word-tile="${touchIds[0]}"]`).boundingBox();
  const targetBox = await touch.locator(`[data-word-tile="${touchIds.at(-1)}"]`).boundingBox();
  const cdp = await touchContext.newCDPSession(touch);
  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
  for (let step = 1; step <= 5; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * step / 5, y: start.y + (end.y - start.y) * step / 5, id: 1 }] });
  await touch.waitForFunction(({ x, y }) => {
    const box = document.querySelector('.drag-ghost')?.getBoundingClientRect();
    return box && Math.abs(box.x + box.width / 2 - x) < 2 && Math.abs(box.y + box.height / 2 - y) < 2;
  }, end);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.deepEqual(await touch.locator('[data-word-tile]').evaluateAll(tiles => tiles.map(tile => Number(tile.dataset.wordTile))), [...touchIds.slice(1), touchIds[0]], 'Touch drag reorders selected tiles');
  await touchContext.close();
  console.log('PASS: mouse/touch dragging, keyboard reorder, ownership colors, repeat-word rejection, compact board, bots, retry recovery and 320px layout.');

  // A distinct pair of browser contexts exercises invitation credentials and complete results.
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  await host.goto(origin);
  await host.locator('#display-name').fill('Grace');
  await host.locator('select[data-seat="1"]').selectOption('human');
  await host.locator('#create-form').getByRole('button', { name: 'Create game' }).click();
  await host.locator('#invite-text').waitFor();
  const invite = await host.locator('#invite-text').innerText();
  assert.equal(await host.locator('[data-action="start"]').isDisabled(), true);
  await guest.goto(invite);
  await guest.locator('#join-name').fill('Linus');
  await guest.getByRole('button', { name: 'Join game' }).click();
  await host.locator('[data-action="start"]').click();
  await host.waitForSelector('[data-tile="24"]');
  host.on('dialog', dialog => dialog.accept()); guest.on('dialog', dialog => dialog.accept());
  await host.locator('[data-action="pass"]').click();
  await guest.locator('[data-action="pass"]').click();
  await guest.locator('.result-banner').waitFor();
  await host.locator('.result-banner').waitFor();
  assert.match(await host.locator('.result-banner').innerText(), /Grace & Linus share the win/);
  await guest.goto(invite);
  await guest.locator('.result-banner').waitFor();
  await host.reload(); await host.locator('.result-banner').waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: isolated human invites, ready/start, complete draw, finished invite resume and refresh.');
  const visual = await browser.newPage({ viewport: { width: 900, height: 650 } });
  await visual.goto(origin);
  const defenseColors = await visual.evaluate(async () => {
    const { renderTile } = await import('/composer.js');
    const seats = Array.from({ length: 4 }, (_, index) => ({ id: `p${index}`, index, displayName: `Player ${index + 1}` }));
    const game = { boardSize: 5, seats, defended: [1] };
    document.querySelector('#app').innerHTML = '<h1>Defended territory</h1><p>Ordinary · defended · defended and selected · word tile</p>' + seats.map(seat => `<section class="word-tray"><strong>Player ${seat.index + 1}</strong><div class="word-tiles">${renderTile(game, { id: 0, owner: seat.id, letter: 'A' }, { wordIndex: 0 })}${renderTile(game, { id: 1, owner: seat.id, letter: 'B' })}${renderTile(game, { id: 1, owner: seat.id, letter: 'C' }, { selectedIndex: 0 })}${renderTile(game, { id: 1, owner: seat.id, letter: 'D' }, { wordIndex: 1 })}</div></section>`).join('');
    return [...document.querySelectorAll('.word-tiles')].map(row => [...row.children].map(tile => ({ color: getComputedStyle(tile).backgroundColor, text: getComputedStyle(tile).color })));
  });
  const rgb = color => color.match(/\d+/g).slice(0, 3).map(Number);
  for (const [normal, defended, selected, word] of defenseColors) {
    const light = rgb(normal.color), dark = rgb(defended.color);
    assert.ok(dark.reduce((a, b) => a + b) < light.reduce((a, b) => a + b), 'Defended shade is deeper');
    const saturation = values => (Math.max(...values) - Math.min(...values)) / Math.max(...values);
    assert.ok(saturation(dark) > saturation(light), 'Defended shade is more saturated');
    assert.equal(defended.color, selected.color);
    assert.equal(defended.color, word.color);
    assert.equal(defended.text, 'rgb(255, 255, 255)');
  }
  await visual.screenshot({ path: 'test-results/defended-tiles.png', fullPage: true });
  console.log('PASS: all four defense colors are deeper/more saturated and retained in selections and word tiles.');
} finally {
  if (browser) await browser.close();
  await new Promise(r => web.close(r));
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
