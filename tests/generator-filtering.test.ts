import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestDatabase, type PostgresDatabase } from './helpers/postgres-test-database.mjs';
import { invalidateLocationCatalogCache, queryLocationCatalog } from '../server/api/repositories/location-catalog';
import { resolveCatalogTarget } from '../server/api/repositories/address-repository';
import app from '../server/api/index';
import type { CountryCode } from '../src/domain/types';

describe('generation-backed location filters', () => {
  let db: PostgresDatabase;
  beforeEach(async () => {
    db = openTestDatabase();
    await db.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path,latitude,longitude) VALUES
      (1,'US','CA','California','California','加利福尼亚州','US/CA',37,-122),
      (2,'US','NY','New York','New York','纽约州','US/NY',41,-74),
      (3,'US','TX','Texas','Texas','得克萨斯州','US/TX',31,-99);
      INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,population,latitude,longitude) VALUES
      (1,'US',1,'Springfield','Springfield','斯普林菲尔德',100,37,-122),
      (2,'US',1,'River Town','River Town','河镇',90,37,-122),
      (3,'US',2,'Springfield','Springfield','斯普林菲尔德',80,41,-74),
      (4,'US',1,'Empty City','Empty City','空城',1000,37,-122);
      INSERT INTO catalog_postcodes(id,country_code,region_id,city_id,code,locality_name,latitude,longitude) VALUES
      (100,'US',1,1,'12345','Springfield',37,-122),
      (101,'US',1,2,'12345','River Town',37,-122),
      (102,'US',2,3,'67890','Springfield',41,-74);`);
    for (let index = 1; index <= 24; index += 1) await db.prepare(`INSERT INTO catalog_postcodes
      (id,country_code,region_id,city_id,code,locality_name) VALUES (?,'US',1,4,?,'Empty City')`)
      .bind(index, String(index).padStart(5, '0')).run();
    for (const [id, region, code, city, postcode, residential] of [
      ['one', 'california', 'ca', 'springfield', '12345', 1],
      ['two', 'california', 'ca', 'river town', '12345', 0],
      ['three', 'new york', 'ny', 'springfield', '67890', 1]
    ] as const) {
      await db.prepare(`INSERT INTO address_pool(id,country_code,street,latitude,longitude,native_language,
        component_variants_json,address_variants_json,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at)
        VALUES (?,'US','Fixture Road',37,-122,'en','{}','{}',.95,'fixture','fixture',1,'2026-01-01','2026-01-01')`)
        .bind(id).run();
      await db.prepare(`INSERT INTO address_generation_index(address_id,country_code,admin1_key,admin1_code_key,
        locality_key,postal_locality_key,postcode_key,residential_ready,random_key,updated_at)
        VALUES (?,'US',?,?,?,?,?,?,1,'2026-01-01')`).bind(id, region, code, city, city, postcode, residential).run();
    }
  });
  afterEach(() => db.close());

  const addIndexedPostcode = async (country: CountryCode, postcode: string, residential = 1, active = 1) => {
    const id = `${country}-${postcode}`;
    await db.prepare(`INSERT INTO address_pool(id,country_code,street,latitude,longitude,native_language,
      component_variants_json,address_variants_json,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at)
      VALUES (?,?,'Fixture Road',37,-122,'en','{}','{}',.95,'fixture','fixture',1,'2026-01-01','2026-01-01')`)
      .bind(id, country).run();
    await db.prepare(`INSERT INTO address_generation_index(address_id,country_code,admin1_key,admin1_code_key,
      locality_key,postal_locality_key,postcode_key,residential_ready,active,random_key,updated_at)
      VALUES (?,?,'fixture region','fr','fixture city','fixture city',?,?,?,1,'2026-01-01')`)
      .bind(id, country, postcode.toLowerCase().replace(/\s/gu, ''), residential, active).run();
  };

  const seedPartialCatalog = async (country: CountryCode, postcode: string, prefix?: string) => {
    await db.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path)
      VALUES (1000,?,'FR','Fixture Region','Fixture Region','测试省',?)`).bind(country, `${country}/FR`).run();
    await db.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name)
      VALUES (1000,?,1000,'Fixture City','Fixture City','测试市'),(1001,?,1000,'Other City','Other City','其他市')`)
      .bind(country, country).run();
    if (prefix) await db.prepare(`INSERT INTO catalog_postcodes(id,country_code,region_id,city_id,code,locality_name)
      VALUES (1000,?,1000,1000,?,'Fixture City')`).bind(country, prefix).run();
    await addIndexedPostcode(country, postcode);
  };

  it.each([
    ['CA', 'K1A 0B1', 'K1A'], ['GB', 'SW1A 1AA', 'SW1A'], ['SA', '11564', undefined]
  ] as const)('offers complete indexed %s postcodes without inventing catalog identities', async (country, postcode, prefix) => {
    await seedPartialCatalog(country, postcode, prefix);
    const result = await queryLocationCatalog(db, { country, field: 'postcode', query: postcode.toLowerCase() });
    expect(result.total).toBe(1);
    expect(result.options).toHaveLength(1);
    const option = result.options[0];
    expect(option.value.replace(/\s/gu, '')).toBe(postcode.replace(/\s/gu, ''));
    expect(option.availableCount).toBe(1);
    expect(option.id).toBeUndefined();
    expect(option.parentId).toBeUndefined();
    expect(option.regionId).toBeUndefined();
    const target = await resolveCatalogTarget(db, country, { postcode: option.value }, 'full-code');
    expect(target?.postcode?.replace(/\s/gu, '')).toBe(postcode.replace(/\s/gu, ''));
    expect(target?.postcodeId).toBeUndefined();
    expect(target?.city).toBeUndefined();
    expect(target?.region).toBeUndefined();
  });

  it('resolves uncatalogued postcodes only inside the explicit generation scope', async () => {
    await seedPartialCatalog('CA', 'K1A 0B1', 'K1A');
    const filters = { postcode: 'k1a \t0b1', regionId: '1000', cityId: '1000' };
    expect(await resolveCatalogTarget(db, 'CA', filters, 'scoped-full-code'))
      .toMatchObject({ postcode: 'K1A0B1', regionId: 1000, cityId: 1000, city: 'Fixture City' });
    expect(await resolveCatalogTarget(db, 'CA', { ...filters, cityId: '1001' }, 'wrong-city')).toBeUndefined();
    expect(await resolveCatalogTarget(db, 'CA', { ...filters, regionId: '1' }, 'wrong-country-region')).toBeUndefined();
    expect(await resolveCatalogTarget(db, 'CA', { ...filters, postcodeId: '9999' }, 'unknown-id')).toBeUndefined();
    expect(await resolveCatalogTarget(db, 'CA', { postcode: 'K1A' }, 'prefix')).toBeUndefined();
    expect(await resolveCatalogTarget(db, 'CA', { postcode: 'K1A0B2' }, 'unknown-code')).toBeUndefined();
    const scoped = await queryLocationCatalog(db, { country: 'CA', field: 'postcode', regionId: '1000', cityId: '1000' });
    expect(scoped.options).toHaveLength(1);
    expect((await queryLocationCatalog(db, { country: 'CA', field: 'postcode', cityId: '1001' })).options).toEqual([]);
  });

  it('paginates complete uncatalogued postcodes and invalidates retired availability', async () => {
    for (let index = 0; index < 25; index += 1) await addIndexedPostcode('SA', String(11000 + index), index % 2);
    await addIndexedPostcode('SA', '11999', 1, 0);
    const input = { country: 'SA' as const, field: 'postcode' as const, limit: 20 };
    const first = await queryLocationCatalog(db, input);
    const second = await queryLocationCatalog(db, { ...input, cursor: first.nextCursor });
    expect(first.total).toBe(25);
    expect(first.options).toHaveLength(20);
    expect(second.options).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.options, ...second.options].map((option) => option.value)).size).toBe(25);
    expect((await queryLocationCatalog(db, { ...input, residential: true })).total).toBe(12);
    await db.exec(`UPDATE address_generation_index SET active=0 WHERE country_code='SA';
      INSERT INTO address_pool_revisions(kind,version) VALUES ('generation:SA','retired-full-codes');`);
    invalidateLocationCatalogCache(db);
    expect((await queryLocationCatalog(db, input)).options).toEqual([]);
    expect(await resolveCatalogTarget(db, 'SA', { postcode: '11000' }, 'retired-code')).toBeUndefined();
  });

  it('filters zero-address postcodes before pagination and never rescans raw evidence', async () => {
    const prepare = vi.spyOn(db, 'prepare');
    const result = await queryLocationCatalog(db, { country: 'US', field: 'postcode', limit: 20 });
    expect(result.total).toBe(2);
    expect(result.availableTotal).toBe(2);
    expect(result.nextCursor).toBeUndefined();
    expect(result.options.map((option) => [option.value, option.availableCount])).toEqual([['12345', 2], ['67890', 1]]);
    const sql = prepare.mock.calls.map(([value]) => value).join('\n');
    expect(sql).toContain('address_generation_index');
    expect(sql).not.toContain('address_pool_evidence');
    expect(sql).not.toMatch(/FROM address_pool\s/u);
  });

  it.each([{ region: 'CA' }, { region: 'California' }, { regionId: '1' }])('uses region name, code and ID consistently: %o', async (scope) => {
    const cities = await queryLocationCatalog(db, { country: 'US', field: 'city', ...scope });
    expect(cities.options.map((option) => option.id)).toEqual(['1', '2']);
    expect(cities.options.map((option) => option.availableCount)).toEqual([1, 1]);
    const postcodes = await queryLocationCatalog(db, { country: 'US', field: 'postcode', ...scope });
    expect(postcodes.options.map((option) => option.value)).toEqual(['12345']);
    expect(postcodes.options[0].availableCount).toBe(2);
  });

  it('keeps residential, city and regional scopes separate', async () => {
    const regions = await queryLocationCatalog(db, { country: 'US', field: 'region' });
    expect(regions.options.map((option) => option.regionCode)).toEqual(['CA', 'NY']);
    const cities = await queryLocationCatalog(db, { country: 'US', field: 'city', residential: true, regionId: '1' });
    expect(cities.options.map((option) => option.id)).toEqual(['1']);
    const postcodes = await queryLocationCatalog(db, { country: 'US', field: 'postcode', cityId: '2' });
    expect(postcodes.options).toHaveLength(1);
    expect(postcodes.options[0]).toMatchObject({ id: '101', parentId: '2', regionId: '1', availableCount: 1 });
    const unknown = await queryLocationCatalog(db, { country: 'US', field: 'city', region: 'not-a-state' });
    expect(unknown.options).toEqual([]);
  });

  it('does not invent a unique city for a postcode shared by several cities', async () => {
    const page = await queryLocationCatalog(db, { country: 'US', field: 'postcode' });
    const shared = page.options.find((option) => option.value === '12345')!;
    expect(shared.id).toBe('100');
    expect(shared.parentId).toBeUndefined();
    expect(shared.regionId).toBe('1');
    const target = await resolveCatalogTarget(db, 'US', { postcodeId: '100' }, 'shared-postcode');
    expect(target?.postcode).toBe('12345');
    expect(target?.city).toBeUndefined();
    expect(target?.region).toBeUndefined();
    expect(await resolveCatalogTarget(db, 'US', { postcodeId: '100', cityId: '2' }, 'explicit-city'))
      .toMatchObject({ postcode: '12345', cityId: 2, city: 'River Town' });
  });

  it('keeps serving the previous snapshot until a publication change is rebuilt in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const input = { country: 'US' as const, field: 'postcode' as const };
      expect((await queryLocationCatalog(db, input)).options).toHaveLength(2);
      await db.exec(`UPDATE address_generation_index SET active=0;
        INSERT INTO address_pool_revisions(kind,version) VALUES ('generation:US','after-retirement');`);
      expect((await queryLocationCatalog(db, input)).options).toHaveLength(2);
      vi.setSystemTime(Date.now() + 3 * 60_000);
      const stale = await queryLocationCatalog(db, input);
      expect(stale.options).toHaveLength(2);
      await vi.waitFor(async () => {
        const fresh = await queryLocationCatalog(db, input);
        expect(fresh.options).toEqual([]);
        expect(fresh.revision).toBe('after-retirement');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['US/CA', 'US/CA/'])('keeps descendant regions in scope without matching sibling prefixes: %s', async (path) => {
    await db.prepare('UPDATE catalog_regions SET path=? WHERE id=1').bind(path).run();
    await db.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,parent_id,path,latitude,longitude) VALUES
      (10,'US','SF','Bay Area','Bay Area','湾区',1,'US/CA/SF/',37,-122),
      (11,'US','OTHER','Other Region','Other Region','其他地区',NULL,'US/CA-other/',41,-74);
      UPDATE catalog_cities SET region_id=10 WHERE id IN (1,2);
      UPDATE catalog_cities SET region_id=11 WHERE id=3;
      UPDATE catalog_postcodes SET region_id=10 WHERE id IN (100,101);
      UPDATE address_generation_index SET admin1_key='bay area',admin1_code_key='sf' WHERE country_code='US' AND admin1_code_key='ca';`);
    const regions = await queryLocationCatalog(db, { country: 'US', field: 'region' });
    expect(regions.options.find((option) => option.id === '1')?.availableCount).toBe(2);
    const cities = await queryLocationCatalog(db, { country: 'US', field: 'city', regionId: '1' });
    expect(cities.options.map((option) => option.id)).toEqual(['1', '2']);
    const target = await resolveCatalogTarget(db, 'US', { regionId: '1' }, 'ancestor');
    expect(target?.regionAliases).toContain('Bay Area');
    const postcodes = await queryLocationCatalog(db, { country: 'US', field: 'postcode', regionId: '1' });
    expect(postcodes.options.map((option) => option.value)).toEqual(['12345']);
    expect(await resolveCatalogTarget(db, 'US', { regionId: '1', cityId: '1' }, 'descendant')).toBeDefined();
    expect(await resolveCatalogTarget(db, 'US', { regionId: '1', cityId: '3' }, 'sibling-prefix')).toBeUndefined();
  });

  it('allows exact catalog filtering when only the actual addresses have coordinates', async () => {
    await db.exec(`UPDATE catalog_regions SET latitude=NULL,longitude=NULL;
      UPDATE catalog_cities SET latitude=NULL,longitude=NULL;
      UPDATE catalog_postcodes SET latitude=NULL,longitude=NULL;`);
    expect(await resolveCatalogTarget(db, 'US', { cityId: '1' }, 'no-center')).toMatchObject({ cityId: 1 });
    expect(await resolveCatalogTarget(db, 'US', { postcodeId: '100' }, 'no-center')).toMatchObject({ postcode: '12345' });
    const postcodes = await queryLocationCatalog(db, { country: 'US', field: 'postcode', regionId: '1' });
    expect(postcodes.options.map((option) => option.value)).toEqual(['12345']);
  });

  it.each(['regionId=1', 'cityId=1', 'postcodeId=100'])('fails closed instead of ignoring %s when catalog lookup fails', async (filter) => {
    const response = await app.request(`/api/v1/generate?country=US&${filter}`, {}, { ADDRESS_DB: db,
      LOCATION_DB: { prepare() { throw new Error('SYNTHETIC_CATALOG_UNAVAILABLE'); } } as unknown as PostgresDatabase });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'LOCATION_CATALOG_UNAVAILABLE' } });
  });
});
