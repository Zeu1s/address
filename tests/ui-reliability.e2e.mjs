import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { generateBundle } from '../src/domain/generator.ts';
import { addressCatalog } from './fixtures/catalog.ts';
import { favoriteFromBundle } from '../src/domain/favorites.ts';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const temporary = resolve(root, 'tmp');
await mkdir(temporary, { recursive: true });
process.env.TEMP = temporary; process.env.TMP = temporary;
const browserPath = [process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find(existsSync);
assert.ok(browserPath, 'Set PLAYWRIGHT_EXECUTABLE_PATH to an installed Chromium browser');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.geojson': 'application/geo+json' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(dist, `.${pathname}`, pathname.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(`${dist}${sep}`)) { response.writeHead(404).end(); return; }
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
let baseUrl = process.env.UI_E2E_BASE_URL;
if (!baseUrl) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({ headless: true, executablePath: browserPath });
const failures = [];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const credential = { id: 'fixture-key', provider: 'amap', label: 'Synthetic credential', mask: 'synthetic****', enabled: true,
  status: 'healthy', quotaService: 'fixture', quotaPeriod: 'month', quotaUsed: 0, quotaLimit: 100, quotaRemaining: 100,
  quotaResetAt: '2099-01-01', quotaUsageSource: 'local' };
const shortcut = { countryCode: 'US', customized: true, popularCities: [], adminShortcuts: [], specialAreas: [],
  specialAreaTitle: { en: 'Original label', 'zh-CN': '原始标题' } };
const maps = { google: { china: false, international: false }, amap: { china: false, international: false },
  amapBrowser: { configured: false, enabled: false, label: '', mask: '', securityMask: '', status: 'disabled' } };
const regions = [
  { id: '1', value: 'California', label: 'California', en: 'California', regionCode: 'CA', availableCount: 1 },
  { id: '2', value: 'New York', label: 'New York', en: 'New York', regionCode: 'NY', availableCount: 1 }
];
const cities = Array.from({ length: 400 }, (_, index) => ({ id: String(index + 1), value: `Synthetic City ${index + 1}`,
  label: `Synthetic City ${index + 1}`, en: `Synthetic City ${index + 1}`, regionId: '1', regionValue: 'California', availableCount: 1 }));
const source = addressCatalog.find((address) => address.countryCode === 'US');
const bundle = generateBundle({ ...source, id: 'ui-synthetic-address' }, false, 'ui-fixture', undefined, new Date('2026-07-20'));
const adminData = {
  '/status': { initialized: true }, '/session': { authenticated: true, passwordChangeRequired: false },
  '/providers': [credential], '/settings/maps': maps, '/settings/translation': { googleTranslationEnabled: true },
  '/settings/country-shortcuts': [shortcut], '/settings/access': { frontendPasswordEnabled: false }, '/tokens': [],
  '/address-data': [], '/settings/blacklist': { keywords: [], builtIn: [] },
  '/sync/queue': { available: true, generatedAt: null, entries: [], job: null }, '/sync/history': { items: [], total: 0, hasMore: false, limit: 100 },
  '/system/status': { todayGrowth: 0, apiRequestsToday: 0, databaseBytes: 0, lastUpdatedAt: null, schedulerHeartbeatAt: null, databaseHealthy: true, schedulerHealthy: true, serviceHealthy: true },
  '/dashboard/overview': { nodes: [], countries: [], metrics: { countryCount: 0, residentialTotal: 0, coveredLowest: 0,
    totalLowest: 0, coverageRate: 0, addressTotal: 0, todayGrowth: 0, apiRequestsToday: 0, databaseBytes: 0, serviceHealthy: true, databaseHealthy: true, schedulerHealthy: true, schedulerHeartbeatAt: null, lastUpdatedAt: null } }
};
const fulfill = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
const mount = async (page, overrides = {}) => {
  await page.route('**/admin/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/admin/api', '');
    if (await overrides.admin?.(route, path, url)) return;
    await fulfill(route, adminData[path] ?? {});
  });
  await page.route('**/web-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/web-api/v1', '');
    if (await overrides.web?.(route, path, url)) return;
    if (path === '/generate') return fulfill(route, { requestId: url.searchParams.get('requestId'), country: 'US', mode: 'address', eligibleCount: 1, result: bundle });
    if (path === '/availability') return fulfill(route, [{ code: 'US', available: true, residentialAvailable: true }]);
    if (path === '/client-context') return fulfill(route, { countryCode: 'US', publicIp: '192.0.2.1' });
    if (path === '/config/maps') return fulfill(route, { countryCode: 'US', googleEnabled: false, amapEnabled: false, amapConfigured: false });
    if (path === '/locations/search') {
      const field = url.searchParams.get('field');
      const offset = Number(url.searchParams.get('cursor') || 0);
      const choices = field === 'city' ? cities : field === 'region' ? regions : [];
      const count = field === 'postcode' ? 100 : 200;
      return fulfill(route, { regions: [], cities: [], postcodes: [], districts: [], [`${field === 'city' ? 'citie' : field}s`]: choices.slice(offset, offset + count),
        total: choices.length, availableTotal: choices.length, nextCursor: offset + count < choices.length ? String(offset + count) : undefined });
    }
    if (path === '/address-translation') return fulfill(route, {}, 503);
    return fulfill(route, {});
  });
};
const hydrated = async (page) => page.waitForFunction(() => !document.querySelector('astro-island[ssr]'));
const check = async (name, test) => {
  if (process.env.UI_E2E_FILTER && !name.includes(process.env.UI_E2E_FILTER)) return;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(5000);
  try { await test(page); assert.deepEqual(errors, []); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  finally { await context.close(); }
};
const noOverflow = async (page) => {
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.right > innerWidth + 1 && !element.closest('.table-scroll, nav, .node-target-table');
    }).slice(0, 6).map((element) => `${element.tagName}.${element.className}`) }));
  assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
};

try {
  await check('translation routes and discovered model capabilities work on desktop and mobile', async (page) => {
    let routes = [
      { id: 'openai:fixture', provider: 'openai-compatible', model: 'a-long-discovered-model-name/with-a-long-version', label: 'Synthetic', priority: 10, enabled: true, status: 'healthy' },
      { id: 'deepl', provider: 'deepl', priority: 20, enabled: true, status: 'healthy' },
      { id: 'google', provider: 'google', priority: 40, enabled: true, status: 'healthy' }
    ];
    await mount(page, { admin: async (route, path) => {
      if (path === '/settings/translation') { await fulfill(route, { googleTranslationEnabled: true, routes }); return true; }
      if (path === '/settings/translation/routes') {
        const changed = route.request().postDataJSON().routes;
        routes = routes.map((row) => ({ ...row, ...changed.find((item) => item.id === row.id) }));
        await fulfill(route, routes); return true;
      }
      if (path === '/providers/openai-compatible/models') {
        const input = route.request().postDataJSON();
        assert.equal(Object.hasOwn(input, 'model'), false);
        await fulfill(route, { models: [
          { id: 'chat-fixture', ownedBy: 'fixture', supportedEndpoints: ['/chat/completions'], reasoningEfforts: ['low', 'medium', 'custom'] },
          { id: 'high-only', ownedBy: 'fixture', supportedEndpoints: ['/chat/completions'], reasoningEfforts: ['high'] },
          { id: 'unknown-efforts', ownedBy: 'fixture', supportedEndpoints: ['/chat/completions'] },
          { id: 'messages-only', ownedBy: 'fixture', supportedEndpoints: ['/messages'] }
        ] }); return true;
      }
    } });
    await page.goto(`${baseUrl}/en/admin/?view=providers`); await hydrated(page);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('.translation-routing').count(), 0);
      const google = page.locator('.translation-google-priority');
      await google.locator('input[name=googleTranslationPriority]').fill('5');
      await google.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('input[name=googleTranslationPriority]')?.value === '5');
      await page.locator('.deepl-provider .translation-provider-header button').click();
      const deepLDialog = page.getByRole('dialog');
      assert.equal(await deepLDialog.locator('input[name=translationPriority]').inputValue(), '20');
      await noOverflow(page);
      await page.keyboard.press('Escape');
      await deepLDialog.waitFor({ state: 'detached' });
      await noOverflow(page);
      await page.locator('.openai-provider .translation-provider-header button').click();
      const dialog = page.getByRole('dialog');
      assert.equal(await dialog.locator('input[name=model]').inputValue(), '');
      assert.equal(await dialog.locator('input[name=reasoningEffort]').inputValue(), 'low');
      await dialog.locator('input[name=model]').fill('manual-before-discovery');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.locator('.openai-provider .translation-provider-header button').click();
      await dialog.locator('input[name=apiKey]').fill('synthetic-key-only');
      await dialog.locator('input[name=baseUrl]').fill('https://example.test/v1/chat/completions');
      await dialog.getByRole('button', { name: 'Fetch models', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('input[name=model]')?.value === 'chat-fixture');
      await dialog.getByRole('listbox').waitFor();
      const effortOptions = dialog.locator('input[name=reasoningEffort]').locator('..').locator('datalist option');
      assert.equal(await dialog.locator('input[name=model]').inputValue(), 'chat-fixture');
      assert.equal(await dialog.getByRole('listbox').getByRole('option').count(), 4, 'Every returned model must remain visible');
      assert.equal(await dialog.getByRole('option', { name: /messages-only/ }).getAttribute('aria-disabled'), 'true');
      await dialog.getByRole('option', { name: /messages-only/ }).click({ force: true });
      assert.equal(await dialog.locator('input[name=model]').inputValue(), 'chat-fixture');
      const sizes = await dialog.locator('.model-picker-controls').evaluate((row) => {
        const input = row.querySelector('input').getBoundingClientRect();
        const button = row.querySelector('.model-fetch-button').getBoundingClientRect();
        return { inputHeight: input.height, buttonHeight: button.height, buttonWidth: button.width };
      });
      assert.deepEqual(sizes, { inputHeight: 40, buttonHeight: 40, buttonWidth: 40 });
      await dialog.locator('input[name=model]').focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert.equal(await dialog.locator('input[name=model]').inputValue(), 'high-only');
      assert.equal(await dialog.locator('input[name=reasoningEffort]').inputValue(), 'high');
      await dialog.getByRole('button', { name: 'Show all models', exact: true }).click();
      assert.equal(await dialog.getByRole('listbox').getByRole('option').count(), 4, 'Opening must ignore the saved model filter');
      await dialog.getByRole('option', { name: 'chat-fixture', exact: true }).click();
      assert.deepEqual(await effortOptions.evaluateAll((options) => options.map((option) => option.value)), ['low', 'medium', 'custom']);
      await dialog.locator('input[name=reasoningEffort]').fill('custom');
      assert.equal(await dialog.locator('input[name=reasoningEffort]').evaluate((input) =>
        new RegExp(input.pattern, 'v').test(input.value) && input.form.checkValidity()), true);
      await dialog.locator('input[name=model]').fill('high-only');
      assert.equal(await dialog.locator('input[name=reasoningEffort]').inputValue(), 'high');
      await dialog.locator('input[name=model]').fill('unknown-efforts');
      assert.equal(await dialog.locator('input[name=reasoningEffort]').inputValue(), 'low');
      assert.equal(await effortOptions.count(), 0);
      assert.ok((await dialog.innerText()).includes('did not advertise reasoning levels'));
      await dialog.locator('input[name=model]').fill('manual/new-model');
      assert.equal(await dialog.locator('input[name=model]').inputValue(), 'manual/new-model');
      assert.equal(await dialog.getByRole('listbox').getByRole('option').count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 1, 'Escape closes only the model list first');
      await dialog.getByRole('button', { name: 'Show all models', exact: true }).click();
      assert.equal(await dialog.getByRole('listbox').getByRole('option').count(), 4);
      await dialog.screenshot({ path: resolve(temporary, `translation-model-${width}.png`) });
      await noOverflow(page);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.screenshot({ path: resolve(temporary, `translation-routes-${width}.png`), fullPage: true });
    }
  });
  await check('queue closure: zero-address administrative nodes remain inspectable with keyboard and mobile', async (page) => {
    const node = { countryCode: 'NL', residentialCount: 0, ordinaryCount: 0, totalCount: 0, updatedAt: '2026-01-01' };
    const country = { ...node, key: 'NL', level: 0, regionName: 'Netherlands', regionNameEn: 'Netherlands', childCount: 1 };
    const region = { ...node, key: 'catalog-region:22', level: 1, regionName: 'Zuid-Holland', regionNameEn: 'Zuid-Holland', childCount: 1 };
    const city = { ...node, key: 'catalog-city:221', level: 2, regionName: 'Rotterdam', regionNameEn: 'Rotterdam', childCount: 0 };
    await mount(page, { admin: async (route, path, url) => {
      if (path !== '/dashboard/overview') return;
      const parent = url.searchParams.get('parent');
      await fulfill(route, { nodes: parent === region.key ? [city] : parent === country.key ? [region] : [country],
        countries: [country], metrics: { ...adminData['/dashboard/overview'].metrics, countryCount: 1 } });
      return true;
    } });
    await page.goto(`${baseUrl}/en/admin/?view=dashboard`); await hydrated(page);
    await page.locator('.country-name-button').filter({ hasText: 'Netherlands' }).click();
    const regionButton = page.locator('.drill-button').filter({ hasText: 'Zuid-Holland' });
    await regionButton.waitFor(); assert.equal(await regionButton.isEnabled(), true);
    await regionButton.focus(); await page.keyboard.press('Enter');
    const cityButton = page.locator('.drill-button').filter({ hasText: 'Rotterdam' });
    await cityButton.waitFor(); assert.equal(await cityButton.isDisabled(), true);
    assert.equal(await page.locator('.coverage-empty-tag').textContent(), 'No address data');
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await page.locator('.coverage-breadcrumb').getByRole('button', { name: 'All countries', exact: true }).click();
    await page.locator('.country-name-button').filter({ hasText: 'Netherlands' }).waitFor();
  });
  await check('continuation: failed favorites deletion preserves the row and can be retried', async (page) => {
    await mount(page);
    await page.goto(`${baseUrl}/en/?country=us`); await hydrated(page);
    await page.evaluate((favorite) => new Promise((resolve, reject) => {
      const request = indexedDB.open('address-favorites', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('favorites', { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('favorites', 'readwrite');
        transaction.objectStore('favorites').put(favorite);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    }), favoriteFromBundle(bundle, 1));
    await page.goto(`${baseUrl}/en/favorites/`); await hydrated(page);
    await page.locator('.favorite-row').waitFor();
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      window.failFavoriteWrite = true;
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] === 'readwrite' && window.failFavoriteWrite) throw new DOMException('Synthetic write failure', 'QuotaExceededError');
        return original.apply(this, args);
      };
    });
    await page.locator('.favorite-remove').click();
    await page.locator('[role=alert]').waitFor();
    assert.equal(await page.locator('.favorite-row').count(), 1);
    await page.evaluate(() => { window.failFavoriteWrite = false; });
    await page.locator('.favorite-remove').click();
    await page.locator('.favorite-row').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.locator('.favorite-row').waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
  });
  const monitorCountry = { key: 'US', countryCode: 'US', level: 0, levelLabel: 'Country', regionCode: '',
    regionName: 'United States', residentialCount: 12, totalCount: 12, childCount: 1, updatedAt: '2026-01-01' };
  const monitorData = { nodes: [monitorCountry], countries: [monitorCountry], metrics: {
    countryCount: 1, residentialTotal: 12, coveredLowest: 1, totalLowest: 2, coverageRate: .5, lastUpdatedAt: '2026-01-01' } };
  await check('continuation: monitor timeout offers an in-place retry', async (page) => {
    let fail = true;
    await page.addInitScript(() => { const timeout = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = () => timeout(80); });
    await mount(page, { web: async (route, path) => {
      if (path !== '/public-monitor') return;
      if (!fail) await fulfill(route, monitorData);
      return true;
    } });
    await page.goto(`${baseUrl}/en/monitor/`); await hydrated(page);
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    fail = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.monitor-region-button').waitFor();
  });
  await check('continuation: expanded monitor map contains and restores keyboard focus', async (page) => {
    await mount(page, { web: async (route, path) => {
      if (path !== '/public-monitor') return;
      await fulfill(route, monitorData); return true;
    } });
    await page.goto(`${baseUrl}/en/monitor/`); await hydrated(page);
    const trigger = page.locator('.map-expand-button');
    await trigger.click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
    for (let index = 0; index < 7; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  });
  await check('continuation: world map load failures recover without hiding the data table', async (page) => {
    let fail = true;
    await mount(page, { web: async (route, path) => {
      if (path !== '/public-monitor') return;
      await fulfill(route, monitorData); return true;
    } });
    await page.route('**/maps/world-map-units.geojson', async (route) => {
      if (fail) await route.fulfill({ status: 503, body: '' }); else await route.continue();
    });
    await page.goto(`${baseUrl}/en/monitor/`); await hydrated(page);
    await page.locator('.world-map-layout [role=alert]').waitFor();
    assert.equal(await page.locator('.monitor-region-button').count(), 1);
    fail = false;
    await page.locator('.world-map-layout').getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.world-map-layout[data-map-state=ready]').waitFor();
    if (process.env.UI_E2E_SCREENSHOTS) await page.screenshot({ path: resolve(temporary, 'final-monitor-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    if (process.env.UI_E2E_SCREENSHOTS) await page.screenshot({ path: resolve(temporary, 'final-monitor-mobile.png'), fullPage: true });
  });
  await check('continuation: world map tooltips use refreshed country counts', async (page) => {
    let reads = 0;
    await mount(page, { web: async (route, path, url) => {
      if (path !== '/public-monitor') return;
      const count = ++reads === 1 ? 12 : 99;
      const country = { ...monitorCountry, residentialCount: count, totalCount: count };
      await fulfill(route, { ...monitorData, nodes: url.searchParams.has('parent') ? [] : [country], countries: [country],
        metrics: { ...monitorData.metrics, residentialTotal: count } }); return true;
    } });
    await page.route('**/maps/world-map-units.geojson', (route) => route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify({
      type: 'FeatureCollection', features: [{ type: 'Feature', properties: { ISO_A2: 'US', LABEL_X: 105, LABEL_Y: 18 },
        geometry: { type: 'Polygon', coordinates: [[[100, 10], [110, 10], [110, 25], [100, 25], [100, 10]]] } }]
    }) }));
    await page.goto(`${baseUrl}/en/monitor/`); await hydrated(page);
    await page.locator('.world-map-layout[data-map-state=ready]').waitFor();
    const hoverCount = async (expected) => page.waitForFunction((count) => {
      const canvas = document.querySelector('.maplibregl-canvas');
      const box = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
        clientX: box.left + box.width * (105 + 180) / 360, clientY: box.top + box.height / 2 }));
      return document.querySelector('.coverage-map-popup span')?.textContent === String(count);
    }, expected).catch(async () => {
      throw new Error(`Popup should show ${expected}, received: ${await page.locator('.coverage-map-popup').allTextContents()}`);
    });
    await hoverCount(12);
    await page.locator('.monitor-region-button').click();
    await page.locator('.coverage-breadcrumb').getByRole('button', { name: 'All countries', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.monitor-table .numeric-cell')?.textContent === '99');
    await hoverCount(99);
  });
  await check('continuation: stalled AMap loader reports failure and retries without affecting generation', async (page) => {
    let fail = true;
    await page.addInitScript(() => {
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 15_000 ? 100 : delay, ...args);
    });
    await mount(page, { web: async (route, path) => {
      if (path !== '/config/maps') return;
      await fulfill(route, { countryCode: 'US', googleEnabled: false, amapEnabled: true, amapConfigured: true,
        amapApiKey: 'synthetic-browser-key', serviceHost: '/_AMapService' }); return true;
    } });
    await page.route('https://webapi.amap.com/maps**', async (route) => {
      if (!fail) await route.fulfill({ contentType: 'application/javascript', body: `window.AMap={
        Map:class {constructor(container){this.container=container;container.dataset.fixtureMap='ready'} add(){} destroy(){delete this.container.dataset.fixtureMap}},Marker:class{}};` });
    });
    await page.goto(`${baseUrl}/en/?country=us`); await hydrated(page);
    await page.locator('.amap-frame .map-error').waitFor();
    assert.ok((await page.locator('.address-card').textContent()).includes(source.components.street));
    fail = false;
    await page.locator('.amap-frame').getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.amap-container[data-fixture-map=ready]').waitFor();
    assert.equal(await page.locator('script[data-address-amap]').count(), 1);
  });
  await check('committed deletion survives provider/maps refresh failures', async (page) => {
    let deleted = false;
    let deletes = 0;
    await mount(page, { admin: async (route, path) => {
      if (path === '/providers/fixture-key' && route.request().method() === 'DELETE') {
        deleted = true; deletes += 1; await fulfill(route, { success: true }); return true;
      }
      if (deleted && ['/providers', '/settings/maps'].includes(path)) { await fulfill(route, {}, 500); return true; }
    } });
    await page.goto(`${baseUrl}/en/admin/?view=providers`); await hydrated(page);
    const row = page.locator('.provider-key-row').filter({ hasText: credential.label });
    await row.waitFor();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog', { name: 'Confirm action', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
    await row.waitFor({ state: 'detached' });
    await page.locator('.admin-error').waitFor();
    assert.equal(deletes, 1);
    await page.locator('.admin-error button').click();
    await page.locator('.admin-error').waitFor();
    assert.equal(await row.count(), 0);
  });
  await check('failed save and explicit refresh preserve shortcut drafts', async (page) => {
    await mount(page, { admin: async (route, path) => {
      if (path === '/settings/country-shortcuts/US' && route.request().method() === 'PUT') { await fulfill(route, {}, 500); return true; }
    } });
    await page.goto(`${baseUrl}/en/admin/?view=shortcuts`); await hydrated(page);
    const input = page.locator('.special-title-editor input').first();
    await input.fill('Unsaved user edit');
    await page.locator('.shortcut-editor .primary-action').click();
    await page.locator('.admin-error').waitFor();
    assert.equal(await input.inputValue(), 'Unsaved user edit');
    await page.locator('.admin-error button').click();
    await page.locator('.admin-error').waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), 'Unsaved user edit');
  });
  await check('partial blacklist mutation responses preserve built-in rules when refresh fails', async (page) => {
    let saved = false;
    await mount(page, { admin: async (route, path) => {
      if (path !== '/settings/blacklist') return;
      if (route.request().method() === 'PUT') {
        saved = true; await fulfill(route, { keywords: ['Synthetic exclusion'] }); return true;
      }
      await fulfill(route, saved ? {} : { keywords: [], builtIn: [{ category: 'fixture', terms: ['Synthetic built-in rule'] }] }, saved ? 503 : 200);
      return true;
    } });
    await page.goto(`${baseUrl}/en/admin/?view=blacklist`); await hydrated(page);
    const input = page.locator('.blacklist-settings textarea');
    await input.fill('Synthetic exclusion');
    await page.locator('.blacklist-settings .primary-action').click();
    await page.locator('.admin-notice').waitFor(); await page.locator('.admin-error').waitFor();
    assert.equal(await input.inputValue(), 'Synthetic exclusion');
    assert.equal(await page.locator('.blacklist-rule-list details').count(), 1);
  });
  await check('all 400 loaded cities are reachable and keyboard focus stays visible', async (page) => {
    await mount(page);
    await page.goto(`${baseUrl}/en/?country=us`); await hydrated(page);
    const input = page.locator('input[role=combobox]').nth(1);
    await input.click();
    const popup = page.locator('.combobox-popup');
    await popup.getByRole('option', { name: 'Synthetic City 1 1', exact: true }).waitFor();
    for (let index = 0; index < 12; index += 1) await input.press('ArrowDown');
    assert.equal(await input.evaluate((element) => {
      const active = document.getElementById(element.getAttribute('aria-activedescendant'));
      const box = active.getBoundingClientRect();
      const list = active.parentElement.getBoundingClientRect();
      return box.top >= list.top - 1 && box.bottom <= list.bottom + 1;
    }), true);
    await popup.getByRole('button', { name: 'Load more', exact: true }).click();
    await popup.getByRole('option', { name: 'Synthetic City 400 1', exact: true }).waitFor();
    assert.ok(await popup.getByRole('option').count() <= 201);
    await popup.getByRole('button', { name: 'Previous page', exact: true }).click();
    await popup.getByRole('option', { name: 'Synthetic City 1 1', exact: true }).waitFor();
    await popup.getByRole('button', { name: 'Next page', exact: true }).click();
    await popup.getByRole('option', { name: 'Synthetic City 400 1', exact: true }).click();
    assert.equal(await input.inputValue(), 'Synthetic City 400');
    assert.equal(await popup.count(), 0);
  });
  await check('postcode selection does not silently add its representative city', async (page) => {
    await mount(page, { web: async (route, path, url) => {
      if (path === '/availability') { await fulfill(route, [{ code: 'CA', available: true, residentialAvailable: true }]); return true; }
      if (path === '/generate') {
        const ca = generateBundle(addressCatalog.find((address) => address.countryCode === 'CA'), false, 'ui-fixture');
        await fulfill(route, { requestId: url.searchParams.get('requestId'), country: 'CA', mode: 'address', eligibleCount: 2, result: ca }); return true;
      }
      if (path === '/locations/search' && url.searchParams.get('field') === 'postcode') {
        await fulfill(route, { postcodes: [{ id: '100', value: '12345', label: '12345', availableCount: 2,
          parentId: '1', parentValue: 'Representative city', regionId: '1', regionValue: 'California' }], total: 1 }); return true;
      }
    } });
    await page.goto(`${baseUrl}/en/?country=ca`); await hydrated(page);
    await page.locator('input[role=combobox]').nth(2).click();
    await page.getByRole('option', { name: '12345 2', exact: true }).click();
    assert.equal(await page.locator('input[role=combobox]').nth(0).inputValue(), '');
    assert.equal(await page.locator('input[role=combobox]').nth(1).inputValue(), '');
  });
  await check('a typed district is chosen with its city and province and stays marked when reopened', async (page) => {
    const districts = Array.from({ length: 300 }, (_, index) => ({ id: `d${index}`, value: `测试区${index}`, label: `测试区${index}`,
      en: `Fixture District ${index}`, zhCN: `测试区${index}`, availableCount: 1, parentId: '9', parentValue: '测试市', regionId: '8', regionValue: '测试省' }));
    districts[250] = { id: 'fengrun', value: '丰润区', label: '丰润区', en: 'Fengrun District', zhCN: '丰润区', availableCount: 28,
      parentId: '20172', parentValue: '唐山市', parentLabel: '唐山市 · 河北省', regionId: '2280', regionValue: '河北省' };
    const generated = [];
    await mount(page, { web: async (route, path, url) => {
      if (path === '/availability') { await fulfill(route, [{ code: 'CN', available: true, residentialAvailable: true }]); return true; }
      if (path === '/generate') { generated.push(Object.fromEntries(url.searchParams)); await fulfill(route, {}, 404); return true; }
      if (path !== '/locations/search') return;
      const field = url.searchParams.get('field');
      const query = (url.searchParams.get('q') || '').toLowerCase();
      const choices = field === 'district' ? districts.filter((option) => !query || option.en.toLowerCase().includes(query))
        : field === 'city' ? [{ id: '20172', value: '唐山市', label: '唐山市', en: 'Tangshan', zhCN: '唐山市', availableCount: 28, regionId: '2280', regionValue: '河北省' }]
          : [{ id: '2280', value: '河北省', label: '河北省', en: 'Hebei', zhCN: '河北省', availableCount: 28 }];
      await fulfill(route, { regions: [], cities: [], postcodes: [], districts: [], [`${field === 'city' ? 'citie' : field}s`]: choices.slice(0, 200),
        total: choices.length, availableTotal: choices.length, nextCursor: choices.length > 200 ? '200' : undefined });
      return true;
    } });
    await page.goto(`${baseUrl}/en/?country=cn`); await hydrated(page);
    const [region, city, district] = [0, 1, 2].map((index) => page.locator('input[role=combobox]').nth(index));
    await district.click();
    await district.fill('fengrun');
    await page.getByRole('option', { name: /Fengrun District/u }).waitFor();
    await district.press('Enter');
    assert.equal(await district.inputValue(), 'Fengrun District');
    assert.equal(await city.inputValue(), 'Tangshan');
    assert.equal(await region.inputValue(), 'Hebei');
    generated.length = 0;
    await page.locator('.generate-button').click();
    await page.waitForFunction(() => document.querySelector('.compact-error'));
    assert.deepEqual([generated.at(-1)?.district, generated.at(-1)?.city, generated.at(-1)?.region], ['丰润区', '唐山市', '河北省']);
    await district.click();
    const selected = page.locator('.combobox-popup [role=option][aria-selected=true]');
    await selected.waitFor();
    assert.match(await selected.innerText(), /Fengrun District/u);
    await district.fill('fixture district 1');
    await district.press('Escape');
    assert.equal(await district.inputValue(), 'Fengrun District');
  });
  await check('desktop and mobile generator/admin pages stay inside the viewport', async (page) => {
    await mount(page);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['/en/?country=us', '/en/admin/?view=providers', '/en/admin/?view=shortcuts',
        '/en/admin/?view=access', '/en/admin/?view=tokens', '/en/admin/?view=addressData',
        '/en/admin/?view=syncQueue', '/en/admin/?view=syncHistory']) {
        await page.goto(`${baseUrl}${route}`); await hydrated(page);
        await noOverflow(page);
      }
    }
  });
  await check('pending secret reveal cannot reappear after tab visibility clears it', async (page) => {
    const gate = deferred(); const started = deferred();
    await mount(page, { admin: async (route, path) => {
      if (path === '/providers/fixture-key/reveal') {
        started.resolve(); await gate.promise; await fulfill(route, { secret: 'synthetic-revealed-secret' }); return true;
      }
    } });
    await page.goto(`${baseUrl}/en/admin/?view=providers`); await hydrated(page);
    const cell = page.locator('.provider-key-row').filter({ hasText: credential.label }).locator('.secret-cell').first();
    await cell.getByRole('button', { name: 'Show', exact: true }).click(); await started.promise;
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const response = page.waitForResponse((value) => value.url().endsWith('/providers/fixture-key/reveal'));
    gate.resolve(); await (await response).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await cell.getByRole('button', { name: /Show|Hide/u }).waitFor();
    assert.equal(await cell.locator('code').textContent(), credential.mask);
  });
  await check('shortcut option failures stay visible and pagination remains keyboard accessible', async (page) => {
    let fail = true;
    await mount(page, { admin: async (route, path, url) => {
      if (path !== '/settings/country-shortcuts/US/options') return;
      const offset = Number(url.searchParams.get('cursor') || 0);
      await fulfill(route, fail ? {} : { options: cities.slice(offset, offset + 100), total: 400,
        nextCursor: offset + 100 < 400 ? String(offset + 100) : undefined }, fail ? 503 : 200);
      return true;
    } });
    await page.goto(`${baseUrl}/en/admin/?view=shortcuts`); await hydrated(page);
    const picker = page.locator('.shortcut-picker').nth(1);
    const input = picker.locator('input');
    await input.focus();
    await picker.locator('[role=alert]').waitFor();
    fail = false;
    await picker.getByRole('button', { name: 'Reload', exact: true }).click();
    await picker.getByRole('option', { name: 'Synthetic City 100 1 addresses', exact: true }).waitFor();
    await picker.getByRole('button', { name: 'Next', exact: true }).click();
    await picker.getByRole('option', { name: 'Synthetic City 101 1 addresses', exact: true }).waitFor();
    assert.ok(await picker.getByRole('option').count() <= 100);
    await input.focus(); await input.press('ArrowDown'); await input.press('Enter');
    assert.equal(await picker.locator('.shortcut-picker-popup').count(), 0);
    await page.locator('.shortcut-editor-row').filter({ hasText: 'Synthetic City 101' }).waitFor();
  });
  await check('failed translation retains the original address and offers a working retry', async (page) => {
    let fail = true;
    await page.addInitScript(() => localStorage.setItem('address-generator-address-language', 'ja'));
    await mount(page, { web: async (route, path) => {
      if (path !== '/address-translation') return;
      await fulfill(route, fail ? {} : { components: { ...source.components, street: 'テスト通り' }, lines: ['テスト通り'], singleLine: 'テスト通り' }, fail ? 503 : 200);
      return true;
    } });
    await page.goto(`${baseUrl}/en/?country=us`); await hydrated(page);
    const error = page.locator('.translation-error');
    await error.waitFor();
    assert.ok((await page.locator('.address-card').textContent()).includes(source.components.street));
    fail = false;
    await error.getByRole('button', { name: 'Retry', exact: true }).click();
    await error.waitFor({ state: 'detached' });
    await page.getByText('テスト通り', { exact: true }).first().waitFor();
  });
  await check('admin session timeout can be retried without reloading the page', async (page) => {
    let fail = true;
    await page.addInitScript(() => { const timeout = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = () => timeout(80); });
    await mount(page, { admin: async (_route, path) => path === '/session' && fail });
    await page.goto(`${baseUrl}/en/admin/?view=providers`); await hydrated(page);
    await page.locator('.admin-error').waitFor();
    fail = false;
    await page.locator('.admin-error').getByRole('button', { name: 'Reload', exact: true }).click();
    await page.locator('.provider-key-row').filter({ hasText: credential.label }).waitFor();
  });
  await check('admin login timeout retains the password and permits retry', async (page) => {
    let fail = true;
    await page.addInitScript(() => { const timeout = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = () => timeout(80); });
    await mount(page, { admin: async (route, path) => {
      if (path === '/session') { await fulfill(route, { authenticated: false }); return true; }
      if (path === '/login') { if (!fail) await fulfill(route, { passwordChangeRequired: false }); return true; }
    } });
    await page.goto(`${baseUrl}/en/admin/?view=providers`); await hydrated(page);
    const input = page.locator('.admin-login input[type=password]');
    await input.fill('synthetic-password');
    await page.locator('.admin-login form > button').click();
    await page.locator('.admin-error').waitFor();
    assert.equal(await input.inputValue(), 'synthetic-password');
    fail = false;
    await page.locator('.admin-login form > button').click();
    await page.locator('.provider-key-row').filter({ hasText: credential.label }).waitFor();
  });
  assert.deepEqual(failures, [], `UI reliability failures: ${failures.join(', ')}`);
} finally {
  await browser.close();
  if (server.listening) await new Promise((done) => server.close(done));
}
