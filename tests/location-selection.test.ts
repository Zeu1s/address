import { describe, expect, it } from 'vitest';
import { exactLocationMatches, filterLocationOptions, sameLocationOption } from '../src/components/App';
import { resolveCatalogTarget } from '../server/api/repositories/address-repository';
import { CN_SYNTHETIC_CITY_PREFIX, decodeSyntheticCityId, decodeSyntheticDistrict, decodeSyntheticDistrictId, queryLocationCatalog } from '../server/api/repositories/location-catalog';
import { locationOptionLabel } from '../src/domain/location-options';

type TargetDb = Parameters<typeof resolveCatalogTarget>[0];
type CatalogDb = Parameters<typeof queryLocationCatalog>[0];

interface ChinaFixture {
  regions?: Array<{ id: number; code?: string; name: string; native_name: string; zh_name: string }>;
  communities?: Array<{ province: string; city: string; district?: string; address_count: number }>;
  catalogCities?: Array<{ id: number; region_id: number | null; name: string; native_name: string; zh_name: string; population?: number | null }>;
  proxy?: { id: number; region_id: number | null; name: string; native_name: string; zh_name: string; population?: number | null };
  statements?: string[];
  bindings?: unknown[][];
}

const chinaDb = (fixture: ChinaFixture): CatalogDb => ({
  prepare(sql: string) {
    fixture.statements?.push(sql);
    let bound: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bound = values; fixture.bindings?.push([sql, ...values]); return statement; },
      async first<T>() {
        if (sql.includes('ORDER BY COALESCE(c.population, 0) DESC LIMIT 1')) return (fixture.proxy ?? null) as T;
        if (sql.includes('FROM catalog_cities WHERE id = ?')) {
          const id = Number(bound[0]);
          return (fixture.catalogCities?.find((city) => city.id === id) ?? null) as T;
        }
        return null as T;
      },
      async all<T>() {
        if (sql.includes('FROM catalog_regions') && sql.includes('parent_id IS NULL')) return { results: fixture.regions || [] } as T;
        if (sql.includes('GROUP BY community.province,community.city,community.district')) {
          return { results: (fixture.communities || []).map((row) => ({ district: '', ...row })) } as T;
        }
        if (sql.includes('FROM catalog_cities c WHERE c.country_code')) return { results: fixture.catalogCities || [] } as T;
        return { results: [] } as T;
      }
    };
    return statement;
  }
} as unknown as CatalogDb);

const generationGroups = (rows: Array<{ name: string; region_name: string | null; region_code: string | null }>) => rows.map((row) => ({
  admin1_key: (row.region_name || '').toLowerCase(), admin1_code_key: (row.region_code || '').toLowerCase(),
  locality_key: row.name.toLowerCase(), postal_locality_key: row.name.toLowerCase(), address_count: 1
}));

const beijingRegion = { id: 2257, code: 'BJ', name: 'Beijing', native_name: '北京市', zh_name: '北京市' };
const hebeiRegion = { id: 2280, code: 'HE', name: 'Hebei', native_name: '河北省', zh_name: '河北省' };

const philadelphia = {
  id: 124126,
  region_id: 1422,
  city_id: 124126,
  postcode: null,
  city_name: 'Philadelphia',
  city_native: 'Philadelphia',
  city_zh: '费城',
  region_name: 'Pennsylvania',
  region_native: 'Pennsylvania',
  region_zh: '宾夕法尼亚州',
  region_code: 'PA',
  latitude: 39.95233,
  longitude: -75.16379
};

const pennsylvania = {
  id: 1422,
  region_id: 1422,
  city_id: null,
  postcode: null,
  city_name: null,
  city_native: null,
  city_zh: null,
  region_name: 'Pennsylvania',
  region_native: 'Pennsylvania',
  region_zh: '宾夕法尼亚州',
  region_code: 'PA',
  latitude: 40.96999,
  longitude: -77.72788
};

const targetDb = (): TargetDb => ({
  prepare(sql: string) {
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bindings = values; return statement; },
      async first<T>() {
        if (sql.includes('SELECT r.id FROM catalog_regions') && sql.includes('r.id = ?')) {
          const id = Number(bindings[1]);
          return (id === 1422 || id === 1452 ? { id } : null) as T;
        }
        if (sql.includes('NULL AS city_id') && sql.includes('FROM catalog_regions r') && sql.includes('WHERE r.id = ?')) {
          return (Number(bindings[0]) === 1422 ? pennsylvania : null) as T;
        }
        if (sql.includes('SELECT c.id, c.region_id FROM catalog_cities') && sql.includes('c.id = ?')) {
          const cityId = Number(bindings[1]);
          const regionId = bindings.length > 2 ? Number(bindings[2]) : undefined;
          return (cityId === 124126 && (regionId === undefined || regionId === 1422)
            ? { id: 124126, region_id: 1422 }
            : null) as T;
        }
        if (sql.includes('WHERE c.id = ?')) return philadelphia as T;
        if (sql.includes('SELECT COUNT(*) AS total FROM catalog_cities')) return { total: 1 } as T;
        if (sql.includes('FROM catalog_cities c') && sql.includes('ORDER BY c.id')) return philadelphia as T;
        return null;
      },
      async all<T>() {
        return { results: sql.includes('FROM catalog_regions') ? [{ id: 1422, parent_id: null, code: 'PA',
          name: 'Pennsylvania', native_name: 'Pennsylvania', zh_name: '宾夕法尼亚州' }] : [] } as T;
      }
    };
    return statement;
  }
} as unknown as TargetDb);

describe('stable location selection', () => {
  it('uses the indexed persisted key for postcode availability', async () => {
    const statements: string[] = [];
    const postcode = {
      address_count: 4, city_count: 1, region_count: 1, id: 1, city_id: 2, code: '1234 AB', locality_name: 'Example', city_name: 'Example',
      city_native_name: 'Example', city_zh_name: 'Example', region_id: 3, region_name: 'North',
      region_native_name: 'North', region_zh_name: 'North', region_code: 'NO'
    };
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: 1 } as T; },
          async all<T>() {
            if (sql.includes('FROM catalog_postcodes p')) return { results: [{ ...postcode, postcode_key: '1234ab' }] } as T;
            if (sql.includes('GROUP BY postcode_key')) return { results: [{
              postcode_key: '1234ab', admin1_key: 'north', admin1_code_key: 'no', locality_key: 'example', postal_locality_key: 'example', address_count: 4
            }] } as T;
            return { results: [] } as T;
          }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country: 'NL', field: 'postcode', limit: 200 });

    expect(result.options[0]).toMatchObject({ value: '1234 AB', availableCount: 4 });
    const indexQueries = statements.filter((sql) => sql.includes('address_generation_index'));
    expect(indexQueries).toHaveLength(2);
    expect(indexQueries.join('\n')).toContain("LOWER(REPLACE(p.code,' ','')) IN (");
    expect(statements.join('\n')).not.toContain('address_pool_evidence');
  });

  it('counts only generator-compatible city names instead of coverage estimates', async () => {
    const statements: string[] = [];
    const row = {
      id: 124126, region_id: 1422, name: 'Philadelphia', native_name: 'Philadelphia', zh_name: '费城',
      region_name: 'Pennsylvania', region_native_name: 'Pennsylvania', region_zh_name: '宾夕法尼亚州', region_code: 'PA'
    };
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async first<T>() { return (sql.includes('SELECT r.id') ? { id: 1422 } : { total: 1 }) as T; },
          async all<T>() {
            if (sql.includes('SELECT c.id, c.region_id')) return { results: [row] } as T;
            if (sql.includes('address_generation_index')) return { results: [
              { ...generationGroups([row])[0], address_count: 8 },
              { ...generationGroups([row])[0], locality_key: 'Philadelphia City', postal_locality_key: '', address_count: 2 }
            ] } as T;
            if (sql.includes('city_id IS NULL')) return { results: [{ city_name: 'Philadelphia City', address_count: 2 }] } as T;
            return { results: [] } as T;
          }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country: 'US', field: 'city', regionId: '1422', residential: true });

    expect(result.options[0]).toMatchObject({ id: '124126', availableCount: 8, disabled: false });
    expect(statements).toContainEqual(expect.stringContaining('FROM address_generation_index'));
    expect(statements.join('\n')).not.toContain('residential_coverage');
  });

  it('keeps parent metadata without adding the parent region to city labels', async () => {
    const rows = [
      {
        id: 124126, region_id: 1422, name: 'Philadelphia', native_name: 'Philadelphia', zh_name: '费城',
        region_name: 'Pennsylvania', region_native_name: 'Pennsylvania', region_zh_name: '宾夕法尼亚州', region_code: 'PA'
      },
      {
        id: 124127, region_id: 1452, name: 'Philadelphia', native_name: 'Philadelphia', zh_name: '费城',
        region_name: 'New York', region_native_name: 'New York', region_zh_name: '纽约州', region_code: 'NY'
      }
    ];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: rows.length } as T; },
          async all<T>() { return { results: sql.includes('SELECT c.id') ? rows : sql.includes('address_generation_index') ? generationGroups(rows) : [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country: 'US', field: 'city', query: 'Philadelphia' });

    expect(result.options).toEqual([
      expect.objectContaining({
        id: '124126', value: 'Philadelphia', parentId: '1422', parentValue: 'Pennsylvania',
        regionId: '1422', regionValue: 'Pennsylvania', regionCode: 'PA'
      }),
      expect.objectContaining({
        id: '124127', value: 'Philadelphia', parentId: '1452', parentValue: 'New York',
        regionId: '1452', regionValue: 'New York', regionCode: 'NY'
      })
    ]);
    expect(result.options[0].label).toBe('Philadelphia · 费城');
    expect(result.options[1].label).toBe('Philadelphia · 费城');
    expect(result.options[0].label).not.toContain('Pennsylvania');
    expect(result.options[1].label).not.toContain('New York');
  });

  it('serves China city options from published communities with catalog ids', async () => {
    const db = chinaDb({
      regions: [{ id: 20, code: 'FJ', name: 'Fujian', native_name: '福建省', zh_name: '福建省' }],
      communities: [{ province: '福建省', city: '厦门市', address_count: 57 }],
      catalogCities: [{ id: 201, region_id: 20, name: 'Xiamen', native_name: '厦门市', zh_name: '厦门市', population: 5163970 }]
    });

    const result = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '20', limit: 20_000 });

    expect(result.total).toBe(1);
    expect(result.availableTotal).toBe(1);
    expect(result.options[0]).toMatchObject({
      value: '厦门市', label: '厦门市', native: '厦门市', en: 'Xiamen', zhCN: '厦门市',
      id: '201', availableCount: 57, disabled: false,
      regionId: '20', regionValue: '福建省', parentId: '20', parentValue: '福建省'
    });
  });

  it.each([
    ['HK', '九龍', 'Kowloon', '九龙'],
    ['TW', '臺北市', 'Taipei', '台北市']
  ] as const)('shows only the native Chinese city name for %s', async (country, nativeName, englishName, chineseName) => {
    const rows = [{
      id: 201, region_id: 20, name: englishName, native_name: nativeName, zh_name: chineseName,
      region_name: 'Region', region_native_name: '地区', region_zh_name: '地区', region_code: 'R'
    }];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: rows.length } as T; },
          async all<T>() { return { results: sql.includes('SELECT c.id') ? rows : sql.includes('address_generation_index') ? generationGroups(rows) : [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country, field: 'city', limit: 20_000 });

    expect(result.options[0].label).toBe(nativeName);
    expect(result.options[0].label).not.toContain('Region');
  });

  it('shows native, English and Chinese names without the parent region for non-Chinese cities', async () => {
    const rows = [{
      id: 201, region_id: 20, name: 'Mexico City', native_name: 'Ciudad de México', zh_name: '墨西哥城',
      region_name: 'Ciudad de México', region_native_name: 'Ciudad de México', region_zh_name: '墨西哥城', region_code: 'CMX'
    }];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: rows.length } as T; },
          async all<T>() { return { results: sql.includes('SELECT c.id') ? rows : sql.includes('address_generation_index') ? generationGroups(rows) : [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country: 'MX', field: 'city', limit: 20_000 });

    expect(result.options[0].label).toBe('Ciudad de México · Mexico City · 墨西哥城');
    expect(result.options[0].label).not.toContain('CMX');
  });

  it('caps a city page at 200 rows so large national catalogs remain responsive', async () => {
    const db = chinaDb({
      regions: [hebeiRegion],
      communities: Array.from({ length: 250 }, (_, index) => ({
        province: '河北省', city: `测试${index}市`, address_count: 250 - index
      }))
    });

    const result = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '2280', limit: 50_000 });

    expect(result.options).toHaveLength(200);
    expect(result.total).toBe(250);
    expect(result.nextCursor).toBe('200');
  });

  it('uses a stable unique order for city pagination', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: 0 } as T; },
          async all<T>() { return { results: [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    await queryLocationCatalog(db, { country: 'AU', field: 'city' });

    expect(statements.find((sql) => sql.includes('SELECT c.id, c.region_id')))
      .toContain('ORDER BY COALESCE(c.population,0) DESC,c.name,c.id');
  });

  it('uses the default page size when a limit is not finite', async () => {
    const db = chinaDb({ regions: [hebeiRegion], communities: Array.from({ length: 120 }, (_, index) => ({
      province: '河北省', city: `Fixture${index}`, address_count: 1
    })) });
    const result = await queryLocationCatalog(db, { country: 'CN', field: 'city', limit: Number.NaN });
    expect(result.options).toHaveLength(100);
    expect(result.nextCursor).toBe('100');
  });

  it('serves China district options from published communities with their own city and province', async () => {
    const db = chinaDb({
      regions: [{ id: 20, code: 'GD', name: 'Guangdong', native_name: '广东省', zh_name: '广东省' }, beijingRegion],
      communities: [
        { province: '广东省', city: '广州市', district: '越秀区', address_count: 3 },
        { province: '广东省', city: '广州市', district: '天河区', address_count: 12 },
        { province: '北京市', city: '北京市', district: '朝阳区', address_count: 7 }
      ],
      catalogCities: [{ id: 201, region_id: 20, name: 'Guangzhou', native_name: '广州', zh_name: '广州' }]
    });

    const result = await queryLocationCatalog(db, { country: 'CN', field: 'district', regionId: '20', cityId: '201', residential: true });

    expect(result.total).toBe(2);
    expect(result.availableTotal).toBe(2);
    expect(result.options).toEqual([
      expect.objectContaining({ value: '天河区', label: '天河区', en: 'Tianhe District', availableCount: 12, disabled: false,
        parentValue: '广州市', parentId: '201', parentLabel: '广州市 · 广东省', regionId: '20', regionValue: '广东省' }),
      expect.objectContaining({ value: '越秀区', availableCount: 3 })
    ]);
    expect(decodeSyntheticDistrict(result.options[0].id)).toEqual({ province: '广东省', city: '广州市', district: '天河区' });
    expect(decodeSyntheticDistrictId(result.options[0].id)).toBe('天河区');
    const nationwide = await queryLocationCatalog(db, { country: 'CN', field: 'district', query: 'chaoyang' });
    expect(nationwide.options).toEqual([expect.objectContaining({ value: '朝阳区', parentLabel: '北京市', regionValue: '北京市' })]);
  });

  it('keeps districts that share a name in different cities apart', async () => {
    const db = chinaDb({
      regions: [beijingRegion, { id: 2271, code: 'JL', name: 'Jilin', native_name: '吉林省', zh_name: '吉林省' }],
      communities: [
        { province: '北京市', city: '北京市', district: '朝阳区', address_count: 120 },
        { province: '吉林省', city: '长春市', district: '朝阳区', address_count: 9 }
      ]
    });
    const result = await queryLocationCatalog(db, { country: 'CN', field: 'district', query: '朝阳' });
    expect(result.options.map((option) => [option.availableCount, option.parentValue])).toEqual([[120, '北京市'], [9, '长春市']]);
    expect(new Set(result.options.map((option) => option.id)).size).toBe(2);
  });

  it('still decodes district ids that carry only the district name', () => {
    const legacy = `cn-district-${Buffer.from('丰润区', 'utf8').toString('hex')}`;
    expect(decodeSyntheticDistrict(legacy)).toEqual({ district: '丰润区' });
    expect(decodeSyntheticDistrict('cn-district-zz')).toBeUndefined();
  });

  it('returns an empty district page for countries without a district catalog', async () => {
    const db = {
      prepare() { throw new Error('unexpected district query'); }
    } as unknown as CatalogDb;

    await expect(queryLocationCatalog(db, { country: 'US', field: 'district' })).resolves.toMatchObject({
      options: [], total: 0, availableTotal: 0, source: 'postgres'
    });
  });

  it('resolves Philadelphia by stable IDs to Pennsylvania and PA', async () => {
    const target = await resolveCatalogTarget(targetDb(), 'US', {
      region: 'Pennsylvania', regionId: '1422', city: 'Philadelphia', cityId: '124126'
    }, 'philadelphia');

    expect(target).toMatchObject({
      regionId: 1422,
      region: 'Pennsylvania',
      regionCode: 'PA',
      cityId: 124126,
      city: 'Philadelphia',
      bucket: 'city-124126'
    });
  });

  it('resolves a region-only filter to the region instead of a random city', async () => {
    const target = await resolveCatalogTarget(targetDb(), 'US', {
      region: 'Pennsylvania', regionId: '1422'
    }, 'pennsylvania');

    expect(target).toMatchObject({
      regionId: 1422,
      region: 'Pennsylvania',
      regionCode: 'PA',
      bucket: 'region-1422'
    });
    expect(target?.cityId).toBeUndefined();
    expect(target?.city).toBeUndefined();
  });

  it('rejects a city ID outside the selected region hierarchy', async () => {
    await expect(resolveCatalogTarget(targetDb(), 'US', {
      regionId: '1452', cityId: '124126'
    }, 'cross-region')).resolves.toBeUndefined();
  });
});

describe('China community-backed selection', () => {
  it('serves the Beijing municipality cascade: region value, one city with count, districts', async () => {
    const fixture: ChinaFixture = {
      regions: [beijingRegion],
      communities: [
        { province: '北京市', city: '北京市', district: '朝阳区', address_count: 120 },
        { province: '北京市', city: '北京市', district: '海淀区', address_count: 80 },
        { province: '北京市', city: '北京市', address_count: 141 }
      ],
      catalogCities: [{ id: 19332, region_id: 2257, name: 'Beijing', native_name: '北京', zh_name: '北京', population: 21893095 }],
      statements: []
    };
    const db = chinaDb(fixture);
    const regions = await queryLocationCatalog(db, { country: 'CN', field: 'region', residential: true });
    expect(regions.options[0]).toMatchObject({ value: '北京市', label: '北京市', en: 'Beijing', availableCount: 341, disabled: false, id: '2257' });
    await expect(queryLocationCatalog(db, { country: 'CN', field: 'region', residential: true })).resolves.toEqual(regions);

    const cities = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '2257', residential: true });
    expect(cities.total).toBe(1);
    expect(cities.options).toEqual([expect.objectContaining({
      value: '北京市', label: '北京市', availableCount: 341, disabled: false,
      id: '19332', parentId: '2257', regionId: '2257', regionValue: '北京市'
    })]);

    // Suffix tolerance keeps catalog 北京 matched to community 北京市.
    const districts = await queryLocationCatalog(db, { country: 'CN', field: 'district', regionId: '2257', cityId: '19332', residential: true });
    expect(districts.options).toEqual([
      expect.objectContaining({ value: '朝阳区', availableCount: 120, parentId: '19332' }),
      expect.objectContaining({ value: '海淀区', availableCount: 80 })
    ]);
    // One grouping serves every field and repeat request.
    expect(fixture.statements?.filter((sql) => sql.includes('cn_communities_v2'))).toHaveLength(1);
  });

  it('dedupes the Tangshan double entry and prefers the exact catalog row', async () => {
    const db = chinaDb({
      regions: [hebeiRegion],
      communities: [
        { province: '河北省', city: '唐山市', address_count: 319 },
        { province: '河北省', city: '石家庄市', address_count: 570 }
      ],
      catalogCities: [
        { id: 20171, region_id: 2280, name: 'Tangshan', native_name: '唐山', zh_name: '唐山', population: 7717983 },
        { id: 20172, region_id: 2280, name: 'Tangshan Shi', native_name: '唐山市', zh_name: '唐山市', population: null },
        { id: 20097, region_id: 2280, name: 'Shijiazhuang Shi', native_name: '石家庄市', zh_name: '石家庄市', population: null }
      ]
    });

    const result = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '2280', residential: true });

    expect(result.options.map(({ value }) => value)).toEqual(['石家庄市', '唐山市']);
    expect(result.options.map(({ value }) => value)).not.toContain('唐山');
    expect(result.options.find(({ value }) => value === '唐山市')).toMatchObject({ id: '20172', availableCount: 319 });
    expect(result.options.find(({ value }) => value === '石家庄市')).toMatchObject({ id: '20097', availableCount: 570 });
  });

  it('maps a municipality without a city-proper catalog row to a proxy id inside its region', async () => {
    const db = chinaDb({
      regions: [{ id: 2249, code: 'SH', name: 'Shanghai', native_name: '上海市', zh_name: '上海市' }],
      communities: [{ province: '上海市', city: '上海市', address_count: 373 }],
      catalogCities: [{ id: 157124, region_id: 2249, name: 'Minhang', native_name: '闵行', zh_name: '闵行', population: 2653489 }],
      proxy: { id: 157124, region_id: 2249, name: 'Minhang', native_name: '闵行', zh_name: '闵行' }
    });

    const result = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '2249', residential: true });

    expect(result.options).toEqual([expect.objectContaining({
      value: '上海市', label: '上海市', availableCount: 373, id: '157124', regionValue: '上海市'
    })]);
  });

  it('falls back to a decodable synthetic id when no catalog city matches', async () => {
    const db = chinaDb({
      regions: [{ id: 2261, code: 'GZ', name: 'Guizhou', native_name: '贵州省', zh_name: '贵州省' }],
      communities: [{ province: '贵州省', city: '黔南布依族苗族自治州', address_count: 150 }]
    });

    const result = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '2261', residential: true });
    const option = result.options[0];
    expect(option.value).toBe('黔南布依族苗族自治州');
    expect(option.id?.startsWith(CN_SYNTHETIC_CITY_PREFIX)).toBe(true);
    expect(decodeSyntheticCityId(option.id)).toBe('黔南布依族苗族自治州');

    const districts = await queryLocationCatalog(chinaDb({
      regions: [{ id: 2261, code: 'GZ', name: 'Guizhou', native_name: '贵州省', zh_name: '贵州省' }],
      communities: [
        { province: '贵州省', city: '黔南布依族苗族自治州', district: '都匀市', address_count: 30 },
        { province: '贵州省', city: '贵阳市', district: '南明区', address_count: 5 }
      ]
    }), { country: 'CN', field: 'district', regionId: '2261', cityId: option.id, residential: true });
    expect(districts.options.map(({ value }) => value)).toEqual(['都匀市']);
  });

  it('matches suffix-tolerant queries and English catalog names when searching cities', async () => {
    const db = chinaDb({
      regions: [hebeiRegion],
      communities: [
        { province: '河北省', city: '唐山市', address_count: 319 },
        { province: '河北省', city: '沧州市', address_count: 308 }
      ],
      catalogCities: [{ id: 20172, region_id: 2280, name: 'Tangshan Shi', native_name: '唐山市', zh_name: '唐山市', population: null }]
    });

    const byChinese = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '2280', query: '唐山' });
    expect(byChinese.options.map(({ value }) => value)).toEqual(['唐山市']);
    const byEnglish = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '2280', query: 'tangshan' });
    expect(byEnglish.options.map(({ value }) => value)).toEqual(['唐山市']);
  });

  it('returns an exact-or-empty city page for an unknown region scope', async () => {
    const db = chinaDb({ regions: [hebeiRegion], communities: [{ province: '河北省', city: '唐山市', address_count: 319 }] });
    await expect(queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '9999' }))
      .resolves.toMatchObject({ options: [], total: 0 });
  });
});


describe('client-side city filtering', () => {
  const options = [
    { value: 'Xiamen', label: '厦门市', native: '厦门市', en: 'Xiamen', zhCN: '厦门市' },
    { value: 'Sao Paulo', label: 'São Paulo · 圣保罗', native: 'São Paulo', en: 'Sao Paulo', zhCN: '圣保罗' },
    { value: 'Munich', label: 'München', native: 'München', en: 'Munich', zhCN: '慕尼黑' }
  ];

  it.each([
    ['XIA', 'Xiamen'],
    ['厦门', 'Xiamen'],
    ['厦门市', 'Xiamen'],
    ['sao', 'Sao Paulo'],
    ['SAOPAULO', 'Sao Paulo'],
    ['MUNICH', 'Munich'],
    ['mun-ich', 'Munich'],
    ['慕尼', 'Munich']
  ])('matches %s against the loaded label/native/en/zhCN values', (query, expected) => {
    expect(filterLocationOptions(options, query).map(({ value }) => value)).toContain(expected);
  });

  it('renders only English in the English interface', () => {
    expect(locationOptionLabel(options[0], 'en')).toBe('Xiamen');
    expect(locationOptionLabel(options[1], 'en')).toBe('Sao Paulo');
  });

  it('renders English first and the localized name second in other interfaces', () => {
    expect(locationOptionLabel(options[0], 'zh-CN')).toBe('Xiamen · 厦门市');
    expect(locationOptionLabel(options[2], 'de')).toBe('Munich · München');
  });
});

describe('combobox selection helpers', () => {
  const tianhe = { id: 'a', value: '天河区', label: '天河区', en: 'Tianhe District', zhCN: '天河区' };
  const chaoyangBeijing = { id: 'b', value: '朝阳区', label: '朝阳区', en: 'Chaoyang District', zhCN: '朝阳区' };
  const chaoyangChangchun = { id: 'c', value: '朝阳区', label: '朝阳区', en: 'Chaoyang District', zhCN: '朝阳区' };

  it('tells same-named options apart by id', () => {
    expect(sameLocationOption(chaoyangBeijing, chaoyangBeijing)).toBe(true);
    expect(sameLocationOption(chaoyangBeijing, chaoyangChangchun)).toBe(false);
    expect(sameLocationOption({ value: '朝阳区', label: '朝阳区' }, chaoyangChangchun)).toBe(true);
    expect(sameLocationOption(undefined, tianhe)).toBe(false);
  });

  it('accepts only a single exact name match when the field is left', () => {
    expect(exactLocationMatches([tianhe, chaoyangBeijing], ' 天河区 ', 'zh-CN')).toEqual([tianhe]);
    expect(exactLocationMatches([tianhe], 'tianhe district', 'en')).toEqual([tianhe]);
    expect(exactLocationMatches([tianhe], '天河', 'zh-CN')).toEqual([]);
    expect(exactLocationMatches([chaoyangBeijing, chaoyangChangchun], '朝阳区', 'zh-CN')).toHaveLength(2);
    expect(exactLocationMatches([tianhe], '', 'zh-CN')).toEqual([]);
  });
});
