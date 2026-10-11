import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { localizeAddressRecords, normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';
import { addressPublicationSqlClause } from '../server/database/generation-index.mjs';

const root = resolve('.data-cache');
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const path = relative(root, directory);
    if (!path || path.startsWith('..')) throw new Error('UNSAFE_FIXTURE_PATH');
    await rm(directory, { recursive: true, force: true });
  }
});
const source = { id: 'preservation-fixture', adapter: 'overture', name: 'Fixture',
  homepageUrl: 'https://example.test', dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0',
  licenseName: 'CC0', licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms', redistributionAllowed: true };
const record = (number) => ({ id: `fixture-${number}`, admin1: 'New York', locality: 'New York',
  postal_city: 'New York', postcode: '10001', street: 'Example Street', number: String(number),
  longitude: -73.99, latitude: 40.75 });
const localize = async (records) => (await localizeAddressRecords(records, {
  environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'false' }
})).map((row) => ({ ...row, localizations: { ...row.localizations,
  'zh-CN': { components: { ...row.components, admin1: '纽约州', locality: '纽约', postalLocality: '纽约', street: '示例街' },
    formattedAddress: `纽约州纽约示例街${row.houseNumber}号`, source: 'fixture' } } }));
const fixture = async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'publication-preservation-'));
  directories.push(directory);
  const file = resolve(directory, 'fixture.jsonl');
  const database = openTestDatabase();
  const importer = new PostgresAddressImporter({ database, normalizeRecord: normalizeSourceRecord,
    hash: (value) => createHash('sha256').update(value).digest('hex'), localizeRecords: localize });
  const run = async (rows, version) => {
    await writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
    return importer.importShard({ shard: { id: 'preservation-us', countryCode: 'US', source },
      discovery: { version, dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: createHash('sha256').update(version).digest('hex') },
      maxRecords: 10, perLocality: 10 });
  };
  return { database, importer, run };
};

describe('publication preservation during source refresh', () => {
  it('preserves validated translations when an unchanged source is reimported without online translation', async () => {
    const { database, importer, run } = await fixture();
    try {
      await run([record(12)], 'v1');
      const before = await database.prepare('SELECT component_variants_json FROM address_pool').first('component_variants_json');
      importer.localizeRecords = (rows) => localizeAddressRecords(rows, { environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'false' } });
      await run([record(12)], 'v2');
      const after = await database.prepare('SELECT component_variants_json FROM address_pool').first('component_variants_json');
      expect(JSON.parse(after)['zh-CN']).toEqual(JSON.parse(before)['zh-CN']);
      expect(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool_runtime WHERE ${addressPublicationSqlClause()}`).first('total')).toBe(1);
    } finally { await database.close(); }
  });

  it('does not interpret an extracted snapshot omission as authoritative deletion', async () => {
    const { database, run } = await fixture();
    try {
      await run([record(12), record(14)], 'v1');
      await run([record(12), record(16)], 'v2');
      expect(await database.prepare('SELECT COUNT(*) AS total FROM address_pool_runtime').first('total')).toBe(3);
      expect(await database.prepare("SELECT COUNT(*) AS total FROM address_pool_evidence WHERE is_primary=1 AND evidence_type='address_existence'").first('total')).toBe(3);
    } finally { await database.close(); }
  });

  it('keeps one primary evidence row when a reimported dataset renames the source record of an address', async () => {
    const { database, run } = await fixture();
    try {
      await run([record(12)], 'v1');
      await run([{ ...record(12), id: 'fixture-12-renamed' }], 'v1');
      expect(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool_evidence
        WHERE is_primary=1 AND is_current=1 AND evidence_type='address_existence'`).first('total')).toBe(1);
    } finally { await database.close(); }
  });
});
