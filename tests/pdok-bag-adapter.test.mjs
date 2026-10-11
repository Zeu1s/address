import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSourceAdapters, normalizePdokBagFeature, selectDispersedSeeds
} from '../server/sync/source-adapters.mjs';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const activeFeature = (identificatie, overrides = {}) => ({
  type: 'Feature',
  id: `feature-${identificatie}`,
  properties: {
    identificatie,
    gebruiksdoel: 'woonfunctie',
    status: 'Verblijfsobject in gebruik',
    geconstateerd: 'N',
    hoofdadres_status: 'Naamgeving uitgegeven',
    openbare_ruimte_status: 'Naamgeving uitgegeven',
    woonplaats_status: 'Woonplaats aangewezen',
    huisnummer: 36,
    huisletter: 'A',
    toevoeging: '1',
    openbare_ruimte_naam: 'Tweede Weteringdwarsstraat',
    postcode: '1017SX',
    woonplaats_naam: 'Amsterdam',
    provincie_naam: 'Noord-Holland',
    ...overrides
  },
  geometry: { type: 'Point', coordinates: [4.88912, 52.36138] }
});

const shard = {
  id: 'pdok-bag-nl-residential',
  countryCode: 'NL',
  maxRecords: 2,
  qualityGate: { minimumRecords: 2 },
  source: {
    id: 'pdok-bag-nl-residential',
    adapter: 'pdok-bag',
    name: 'Kadaster BAG active residential objects via PDOK',
    dataUrl: 'https://api.pdok.nl/kadaster/bag/ogc/v2/collections/verblijfsobject?f=json'
  }
};

describe('PDOK BAG residential source', () => {
  it('keeps only complete, active, exclusively residential official objects', () => {
    expect(normalizePdokBagFeature(activeFeature('0363010000554723'))).toMatchObject({
      source_record_id: '0363010000554723', number: '36A-1', street: 'Tweede Weteringdwarsstraat',
      locality: 'Amsterdam', admin1: 'Noord-Holland', postcode: '1017SX',
      property_type: 'residential', residential_building_class: 'bag:woonfunctie'
    });
    for (const feature of [
      activeFeature('0363010000554723', { gebruiksdoel: 'bijeenkomstfunctie,woonfunctie' }),
      activeFeature('0363010000554723', { status: 'Verblijfsobject ingetrokken' }),
      activeFeature('0363010000554723', { geconstateerd: 'Y' }),
      activeFeature('0363010000554723', { hoofdadres_status: 'Naamgeving ingetrokken' }),
      activeFeature('0363010000554723', { postcode: '' }),
      { ...activeFeature('0363010000554723'), geometry: { type: 'Point', coordinates: [0, 0] } }
    ]) expect(normalizePdokBagFeature(feature)).toBeNull();
  });

  it('selects deterministic seeds across the country and removes dense duplicates', () => {
    const values = [
      { latitude: 50.85, longitude: 5.69 }, { latitude: 50.851, longitude: 5.691 },
      { latitude: 51.44, longitude: 5.48 }, { latitude: 52.09, longitude: 5.12 },
      { latitude: 52.37, longitude: 4.90 }, { latitude: 53.22, longitude: 6.57 },
      { latitude: 0, longitude: 0 }
    ];
    const selected = selectDispersedSeeds(values, 3);
    expect(selected).toHaveLength(3);
    expect(Math.max(...selected.map(({ latitude }) => latitude)) - Math.min(...selected.map(({ latitude }) => latitude))).toBeGreaterThan(1);
    expect(selectDispersedSeeds(values, 3)).toEqual(selected);
  });

  it('resumes from the official next cursor, deduplicates, and cleans checkpoints after completion', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'pdok-bag-'));
    directories.push(cacheDir);
    const calls = [];
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname.endsWith('/verblijfsobject')) return new Response(JSON.stringify({
        links: [
          { rel: 'self', updated: '2026-08-03T00:00:00Z' },
          { rel: 'items', type: 'application/geo+json', href: `${url.origin}${url.pathname}/items?f=json` }
        ]
      }), { headers: { 'content-type': 'application/json' } });
      const cursor = url.searchParams.get('cursor');
      const payload = cursor ? {
        type: 'FeatureCollection', features: [activeFeature('0363010000554724', { huisnummer: 37 })], links: []
      } : {
        type: 'FeatureCollection',
        features: [
          activeFeature('0363010000554723'),
          activeFeature('0363010000554799', { gebruiksdoel: 'kantoorfunctie,woonfunctie' })
        ],
        links: [{ rel: 'next', href: `${url.origin}${url.pathname}?f=json&cursor=next-page&limit=1000` }]
      };
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/geo+json' } });
    });
    const loadSeedLocations = async () => [{ latitude: 52.37, longitude: 4.90 }];
    const paused = createSourceAdapters({
      fetchImpl, loadSeedLocations, environment: { PDOK_BAG_MAX_REQUESTS_PER_RUN: '1' }
    });
    const discovery = await paused.discover(shard);
    await expect(paused.materialize(shard, discovery, {
      cacheDir, maxRecords: 2, perLocality: 2
    })).rejects.toMatchObject({ code: 'SOURCE_PARTIAL' });

    const resumed = createSourceAdapters({ fetchImpl, loadSeedLocations, environment: {} });
    const materialized = await resumed.materialize(shard, discovery, {
      cacheDir, maxRecords: 2, perLocality: 2
    });
    const records = (await readFile(materialized.file, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(records.map((record) => record.source_record_id)).toEqual(['0363010000554723', '0363010000554724']);
    expect(calls.filter((url) => url.includes('cursor=next-page'))).toHaveLength(1);
    expect(await readdir(join(cacheDir, 'raw'))).toEqual([]);
  });

  it('reads the collection update time from the top level of current OGC API metadata', async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      return new Response(JSON.stringify({
        updated: '2026-10-10T00:00:00Z',
        links: [
          { rel: 'self', type: 'application/json', href: url.href },
          { rel: 'items', type: 'application/geo+json', href: `${url.origin}${url.pathname}/items?f=json` }
        ]
      }), { headers: { 'content-type': 'application/json' } });
    });
    const discovery = await createSourceAdapters({ fetchImpl, loadSeedLocations: async () => [], environment: {} }).discover(shard);
    expect(discovery).toMatchObject({ adapter: 'pdok-bag', publishedAt: '2026-10-10T00:00:00.000Z' });
    expect(discovery.version).toMatch(/^2026-10-10-/u);
  });

  it('visits every dispersed seed before requesting a deeper page', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'pdok-bag-round-robin-'));
    directories.push(cacheDir);
    const calls = [];
    let sequence = 0;
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname.endsWith('/verblijfsobject')) return new Response(JSON.stringify({
        links: [
          { rel: 'self', updated: '2026-08-03T00:00:00Z' },
          { rel: 'items', type: 'application/geo+json', href: `${url.origin}${url.pathname}/items?f=json` }
        ]
      }), { headers: { 'content-type': 'application/json' } });
      const cursor = url.searchParams.get('cursor');
      const index = String(1000000000000000 + sequence++);
      return new Response(JSON.stringify({
        type: 'FeatureCollection', features: [activeFeature(index, { huisnummer: sequence })],
        links: cursor ? [] : [{ rel: 'next', href: `${url.origin}${url.pathname}?f=json&cursor=${encodeURIComponent(index)}&limit=1` }]
      }), { headers: { 'content-type': 'application/geo+json' } });
    });
    const adapter = createSourceAdapters({
      fetchImpl,
      loadSeedLocations: async () => [
        { latitude: 50.8, longitude: 5.6 }, { latitude: 52.1, longitude: 5.1 }, { latitude: 53.2, longitude: 6.5 }
      ],
      environment: {}
    });
    const localShard = { ...shard, maxRecords: 4, qualityGate: { minimumRecords: 4 } };
    const discovery = await adapter.discover(localShard);
    await adapter.materialize(localShard, discovery, { cacheDir, maxRecords: 4, perLocality: 2 });
    const itemCalls = calls.filter((url) => url.includes('/items'));
    expect(itemCalls.slice(0, 3).every((url) => !url.includes('cursor='))).toBe(true);
    expect(itemCalls.some((url) => url.includes('cursor='))).toBe(true);
  });
});
