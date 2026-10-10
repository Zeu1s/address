import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Database } from '../database/database.mjs';
import { countries, countryByCode, isCountryCode } from '../../src/domain/countries';
import { publicOpenApiDocument } from '../../src/domain/api-contract';
import { evaluateCountryGoals } from '../sync/country-goals.mjs';
import type { ClientContext } from '../../src/domain/client-context';
import { DomainError, generateBundle } from '../../src/domain/generator';
import { locationOptions, regionsForCountry } from '../../src/domain/location-options';
import { isVerifiedAddressNonResidential } from '../../src/domain/non-residential.mjs';
import { matchesCustomBlacklist } from '../lib/custom-blacklist.mjs';
import { originAllowed, parseAllowedOrigins } from '../lib/origin-policy';
import type { GeneratedBundle } from '../../src/domain/types';
import type { VerifiedAddress } from '../../src/domain/types';
import {
  resolveCatalogTarget,
  resolveNearestCatalogTarget,
  type CatalogTarget,
  type AddressFilters
} from './repositories/address-repository';
import { loadAddressPoolV2AddressById, pickAddressPoolV2Address, pickNearestAddressPoolV2Address } from './repositories/address-pool-v2';
import { CN_SYNTHETIC_CITY_PREFIX, decodeSyntheticCityId, decodeSyntheticDistrict, queryLocationCatalog, type CatalogField } from './repositories/location-catalog';
import { countChinaCommunities, loadChinaCommunityAddressById, pickChinaCommunityAddress } from './repositories/china-community';
import { isTranslatableLocale, translateAddressComponents } from './services/address-translation';
import { clientContextFromRequest } from './services/client-context';
import { lookupManualIpContext, ManualIpLookupError } from './services/ip-geolocation';
import type { RandomAddressService } from './services/random-address-service';

interface Bindings {
  LOCATION_DB?: Database;
  ADDRESS_DB?: Database;
  RANDOM_ADDRESS_SERVICE?: RandomAddressService;
  IP_GEOLOCATION_API_URL?: string;
  IP_GEOLOCATION_FALLBACK_API_URL?: string;
  ALLOWED_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  HOT_POOL_COUNTRIES?: string;
  HOT_POOL_MIN_PER_SLOT?: string;
  GOOGLE_GEOCODING_API_KEY?: string;
  GOOGLE_GEOCODING_MOCK?: string;
  AMAP_API_KEY?: string;
  GEOAPIFY_API_KEY?: string;
  GOOGLE_TRANSLATION_ENABLED?: boolean | string;
  ONEMAP_ACCESS_TOKEN?: string;
  YOUDAO_APP_KEY?: string;
  YOUDAO_APP_SECRET?: string;
  TRUST_PROXY?: string;
  API_TOKEN_AUTHENTICATED?: boolean;
  BATCH_GENERATION_CONCURRENCY?: string;
  GENERATION_SLOT?: { tryAcquire: () => boolean; release: () => void };
  BATCH_GENERATION_SLOT?: { tryAcquire: () => boolean; release: () => void };
  incoming?: { socket?: { remoteAddress?: string } };
}

const app = new Hono<{ Bindings: Bindings }>();

const requestContext = (request: Request, env: Bindings): ClientContext => clientContextFromRequest(request, {
  socketIp: env.incoming?.socket?.remoteAddress,
  trustProxy: env.TRUST_PROXY === 'true'
});

const locateRequestIp = async (request: Request, env: Bindings): Promise<ClientContext> => {
  const network = requestContext(request, env);
  if (!network.publicIp) return network;
  try {
    return withRequestNetworkContext(
      await lookupManualIpContext(network.publicIp, env.IP_GEOLOCATION_API_URL, fetch, env.IP_GEOLOCATION_FALLBACK_API_URL),
      network
    );
  } catch {
    return network;
  }
};

const withRequestNetworkContext = (location: ClientContext, requestContext: ClientContext): ClientContext => ({
  ...location,
  ...(requestContext.publicIp ? { publicIp: requestContext.publicIp } : {}),
  localDevelopment: requestContext.localDevelopment
});
const LOCATION_CACHE_SECONDS = 30 * 24 * 60 * 60;

interface CacheEntry<T> { data: T; expiresAt: number }

class MemoryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly maximumEntries: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.data as T;
  }

  set(key: string, data: unknown, seconds: number): void {
    this.entries.delete(key);
    this.entries.set(key, { data, expiresAt: Date.now() + seconds * 1000 });
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

const locationCache = new MemoryCache(2_000);
const poolMetadataCache = new WeakMap<object, {
  expiresAt: number;
  v1?: Map<string, number>;
  v2?: Map<string, AddressPoolV2Count>;
}>();
const countryGoalCache = new WeakMap<object, { expiresAt: number; promise: ReturnType<typeof evaluateCountryGoals> }>();

const cachedCountryGoals = (db: Database): ReturnType<typeof evaluateCountryGoals> => {
  const key = db as object;
  const cached = countryGoalCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = evaluateCountryGoals(db);
  countryGoalCache.set(key, { expiresAt: Date.now() + 10_000, promise });
  void promise.catch(() => {
    if (countryGoalCache.get(key)?.promise === promise) countryGoalCache.delete(key);
  });
  return promise;
};

type GenerateTimingStage = 'pool' | 'provider' | 'localize';
type GenerateTimings = Record<GenerateTimingStage, number>;

const measureStage = async <T,>(timings: GenerateTimings, stage: GenerateTimingStage, task: () => Promise<T>): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    timings[stage] += performance.now() - startedAt;
  }
};

const toleratePoolFailure = async <T,>(task: () => Promise<T>): Promise<T | undefined> => task();

const serverTiming = (startedAt: number, timings: GenerateTimings): string => [
  ['total', performance.now() - startedAt],
  ['pool', timings.pool],
  ['provider', timings.provider],
  ['localize', timings.localize]
].map(([name, duration]) => `${name};dur=${Number(duration).toFixed(1)}`).join(', ');

export const filterProviderCandidates = (candidates: VerifiedAddress[]): VerifiedAddress[] =>
  candidates.filter((candidate) => !isVerifiedAddressNonResidential(candidate)
    && !matchesCustomBlacklist([
      candidate.components.buildingName,
      candidate.formattedAddress,
      candidate.nativeAddress,
      candidate.components.street
    ]));

const locationCacheKey = (
  country: string, field: string, residential: boolean, region: string | undefined, query: string,
  regionId: string | undefined, city: string | undefined, cityId: string | undefined,
  cursor: string | undefined, limit: number
): string => {
  const url = new URL('https://address.internal/location-options');
  url.searchParams.set('version', '3');
  url.searchParams.set('country', country);
  url.searchParams.set('field', field);
  url.searchParams.set('residential', String(residential));
  if (region) url.searchParams.set('region', region);
  if (regionId) url.searchParams.set('regionId', regionId);
  if (city) url.searchParams.set('city', city);
  if (cityId) url.searchParams.set('cityId', cityId);
  if (query) url.searchParams.set('query', query);
  if (cursor) url.searchParams.set('cursor', cursor);
  url.searchParams.set('limit', String(limit));
  return url.href;
};

const readLocationCache = <T,>(key: string): T | undefined => locationCache.get(key);

const writeLocationCache = (key: string, data: unknown): void => locationCache.set(key, data, LOCATION_CACHE_SECONDS);

const withGenerationSlot = async (
  env: Bindings,
  task: () => Promise<Response>
): Promise<Response> => {
  const slot = env.GENERATION_SLOT;
  const batchSlot = env.BATCH_GENERATION_SLOT;
  const selected = batchSlot || slot;
  if (!selected) return task();
  if (!selected.tryAcquire()) {
    return Response.json({ error: 'GENERATION_BUSY' }, {
      status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' }
    });
  }
  try { return await task(); }
  finally { selected.release(); }
};

const addressPoolCounts = async (db: Database | undefined): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  if (!db) return counts;
  const cached = poolMetadataCache.get(db as object);
  if (cached?.v1 && cached.expiresAt > Date.now()) return cached.v1;
  const rows = await db.prepare('SELECT country_code, COUNT(*) AS total FROM address_pool WHERE active = 1 GROUP BY country_code')
    .all<{ country_code: string; total: number }>();
  for (const row of rows.results || []) counts.set(row.country_code, Number(row.total || 0));
  poolMetadataCache.set(db as object, { ...poolMetadataCache.get(db as object), expiresAt: Date.now() + 30_000, v1: counts });
  return counts;
};

interface AddressPoolV2Count { total: number; residential: number }

interface AddressPoolV2CountRow { country_code: string; total: number; residential: number }

interface HotPoolCountryRow {
  country_code: string;
  slot_count: number;
  ready_slot_count: number;
  active_count: number;
}

interface LowWaterSlotRow {
  coverage_key: string;
  country_code: string;
  admin1_key: string;
  locality_key: string;
  property_type: string;
  active_count: number;
  minimum_count: number;
  refresh_status: string;
  expires_at: string | null;
}

interface HotPoolCoverage {
  available: boolean;
  countries: HotPoolCountryRow[];
  lowWaterSlots: LowWaterSlotRow[];
}

const addressPoolV2Counts = async (db: Database | undefined): Promise<Map<string, AddressPoolV2Count>> => {
  const counts = new Map<string, AddressPoolV2Count>();
  if (!db) return counts;
  const cached = poolMetadataCache.get(db as object);
  if (cached?.v2 && cached.expiresAt > Date.now()) return cached.v2;
  const [stateRows, indexRows] = await Promise.all([
    db.prepare(`SELECT country_code,address_count AS total,
      residential_count AS residential FROM sync_country_state ORDER BY country_code`)
      .all<AddressPoolV2CountRow>(),
    db.prepare(`SELECT country_code,COUNT(*) AS total,SUM(residential_ready) AS residential
      FROM address_generation_index WHERE active=1 GROUP BY country_code ORDER BY country_code`)
      .all<AddressPoolV2CountRow>()
  ]);
  const indexed = new Map((indexRows.results || []).map((row) => [row.country_code, {
    total: Number(row.total || 0), residential: Number(row.residential || 0)
  }]));
  for (const row of stateRows.results || []) {
    counts.set(row.country_code, indexed.get(row.country_code) || {
      total: Number(row.total || 0), residential: Number(row.residential || 0)
    });
  }
  for (const [countryCode, count] of indexed) {
    if (!counts.has(countryCode)) counts.set(countryCode, count);
  }
  poolMetadataCache.set(db as object, { ...poolMetadataCache.get(db as object), expiresAt: Date.now() + 30_000, v2: counts });
  return counts;
};

// One country-count snapshot for public pages: the precomputed coverage totals the admin console also shows.
// A stale snapshot is served while it refreshes so no request waits on a recount.
const countrySnapshots = new WeakMap<object, { counts: Map<string, AddressPoolV2Count>; expiresAt: number; pending?: Promise<Map<string, AddressPoolV2Count>> }>();
const loadCountrySnapshot = async (db: Database): Promise<Map<string, AddressPoolV2Count>> => {
  const rows = await db.prepare(`SELECT country_code,total_count AS total,residential_count AS residential
    FROM admin_coverage_stats WHERE level=0 AND total_count IS NOT NULL ORDER BY country_code`)
    .all<AddressPoolV2CountRow>().catch(() => ({ results: [] as AddressPoolV2CountRow[] }));
  if (!rows.results?.length) {
    const [counts, chinaCount] = await Promise.all([addressPoolV2Counts(db), countChinaCommunities(db)]);
    counts.set('CN', { total: chinaCount, residential: chinaCount });
    return counts;
  }
  return new Map(rows.results.map((row) => [row.country_code, { total: Number(row.total || 0), residential: Number(row.residential || 0) }]));
};
const publishedCountryCounts = async (db: Database | undefined): Promise<Map<string, AddressPoolV2Count>> => {
  if (!db) return new Map();
  const snapshot = countrySnapshots.get(db as object);
  if (snapshot && snapshot.expiresAt > Date.now()) return snapshot.counts;
  const refresh = () => {
    const pending = loadCountrySnapshot(db).then((counts) => {
      countrySnapshots.set(db as object, { counts, expiresAt: Date.now() + 60_000 });
      return counts;
    }).catch((error) => {
      const current = countrySnapshots.get(db as object);
      if (current) delete current.pending;
      throw error;
    });
    countrySnapshots.set(db as object, { counts: snapshot?.counts || new Map(), expiresAt: snapshot?.expiresAt || 0, pending });
    return pending;
  };
  if (snapshot) {
    if (!snapshot.pending) void refresh().catch(() => undefined);
    return snapshot.counts;
  }
  return refresh();
};

const hotPoolCoverage = async (
  db: Database | undefined,
  requiredCountries: string[],
  minimumPerSlot: number
): Promise<HotPoolCoverage> => {
  if (!db || !requiredCountries.length) return { available: false, countries: [], lowWaterSlots: [] };
  const placeholders = requiredCountries.map(() => '?').join(',');
  const evaluated = `WITH evaluated AS (
    SELECT coverage.coverage_key, coverage.country_code, coverage.admin1_key, coverage.locality_key,
      coverage.property_type,
      CASE WHEN coverage.property_type IN ('residential','apartment')
        THEN coverage.residential_count ELSE coverage.active_count END AS active_count,
      CASE WHEN target_count > ? THEN target_count ELSE ? END AS minimum_count,
      coverage.refresh_status, coverage.expires_at
    FROM pool_coverage coverage
    WHERE coverage.country_code IN (${placeholders})
  )`;
  const summary = await db.prepare(`${evaluated}
    SELECT country_code, COUNT(*) AS slot_count, SUM(active_count) AS active_count,
      SUM(CASE WHEN active_count >= minimum_count AND refresh_status = 'ready' THEN 1 ELSE 0 END) AS ready_slot_count
    FROM evaluated GROUP BY country_code ORDER BY country_code`)
    .bind(minimumPerSlot, minimumPerSlot, ...requiredCountries).all<HotPoolCountryRow>();
  const lowWater = await db.prepare(`${evaluated}
    SELECT coverage_key, country_code, admin1_key, locality_key, property_type, active_count,
      minimum_count, refresh_status, expires_at
    FROM evaluated
    WHERE active_count < minimum_count OR refresh_status <> 'ready'
    ORDER BY (minimum_count - active_count) DESC, country_code, coverage_key LIMIT 100`)
    .bind(minimumPerSlot, minimumPerSlot, ...requiredCountries).all<LowWaterSlotRow>();
  return {
    available: true,
    countries: summary.results || [],
    lowWaterSlots: lowWater.results || []
  };
};

app.use('*', async (context, next) => {
  const allowed = parseAllowedOrigins(context.env.ALLOWED_ORIGINS, context.env.ALLOWED_ORIGIN);
  const origin = context.req.header('Origin') || '';
  if (context.req.method === 'OPTIONS' && origin && !originAllowed(allowed, origin)) {
    return context.json({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
  }
  return cors({
    origin: allowed,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600
  })(context, async () => {
    await next();
    context.header('X-Content-Type-Options', 'nosniff');
  });
});

app.get('/', (context) => context.json({ service: 'Real Address Generator API', version: 'v1' }));
app.get('/api/v1/health', (context) => context.json({ status: 'ok' }));
app.get('/api/v1/ready', async (context) => {
  try {
    if (!context.env.ADDRESS_DB) throw new Error('DATABASE_UNAVAILABLE');
    await context.env.ADDRESS_DB.prepare('SELECT 1 AS ready').first();
    return context.json({ status: 'ready' });
  } catch {
    return context.json({ status: 'unavailable' }, 503);
  }
});
app.get('/api/v1/openapi.json', (context) => context.json(publicOpenApiDocument));

app.get('/api/v1/countries', async (context) => {
  const coverage = new Map<string, number>();
  const poolV2Counts = await publishedCountryCounts(context.env.ADDRESS_DB);
  const chinaCommunities = poolV2Counts.get('CN')?.total || 0;
  if (context.env.LOCATION_DB) {
    const rows = await context.env.LOCATION_DB.prepare('SELECT country_code, SUM(GREATEST(total_count,address_count)) AS total FROM residential_coverage GROUP BY country_code')
      .all<{ country_code: string; total: number }>();
    for (const row of rows.results || []) coverage.set(row.country_code, Number(row.total || 0));
  }
  const hasPoolDatabase = Boolean(context.env.LOCATION_DB || context.env.ADDRESS_DB);
  const data = countries.map((country) => {
    const v2 = poolV2Counts.get(country.code);
    const synchronizedCount = context.env.ADDRESS_DB ? v2?.total || 0 : coverage.get(country.code) || 0;
    // China is stored in its own community table. Always use its publication
    // count, including zero, so a stale sync_country_state value cannot leak
    // into the public country list.
    const addressCount = country.code === 'CN' && context.env.ADDRESS_DB ? chinaCommunities : synchronizedCount;
    const residentialCount = country.code === 'CN' ? addressCount : v2?.residential || 0;
    return {
      ...country,
      addressCount: hasPoolDatabase ? addressCount : null,
      residentialCount: hasPoolDatabase ? residentialCount : country.residentialCapability ? null : 0,
      residentialAvailable: hasPoolDatabase ? residentialCount > 0 : false,
      available: hasPoolDatabase ? addressCount > 0 : false,
      generationMode: addressCount > 0 ? 'synchronized-pool' : 'sync-required'
    };
  });
  context.header('Cache-Control', 'no-store');
  return context.json({ data });
});

app.get('/api/v1/availability', async (context) => {
  if (!context.env.ADDRESS_DB) return context.json({ data: [] });
  const counts = await publishedCountryCounts(context.env.ADDRESS_DB);
  context.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return context.json({ data: [...counts].filter(([, count]) => count.total > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, available: true, residentialAvailable: count.residential > 0 })) });
});

app.get('/api/v1/client-context', async (context) => {
  const manualIp = context.req.query('ip');
  const network = requestContext(context.req.raw, context.env);
  const data = manualIp === undefined
    ? await locateRequestIp(context.req.raw, context.env)
    : withRequestNetworkContext(
      await lookupManualIpContext(manualIp, context.env.IP_GEOLOCATION_API_URL, fetch, context.env.IP_GEOLOCATION_FALLBACK_API_URL),
      network
    );
  context.header('Cache-Control', 'no-store');
  return context.json({ data });
});

app.get('/api/v1/locations/search', async (context) => {
  const country = context.req.query('country')?.toUpperCase() || 'US';
  if (!isCountryCode(country)) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${country}`);
  const config = countryByCode.get(country);
  if (!config) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${country}`);
  const fieldQuery = context.req.query('field') || 'city';
  if (!['region', 'city', 'district', 'postcode'].includes(fieldQuery)) throw new DomainError('INVALID_FIELD', 'Unknown location field.');
  const field = fieldQuery as CatalogField;
  const query = context.req.query('q')?.trim() || '';
  const region = context.req.query('region') || undefined;
  const regionId = context.req.query('regionId') || undefined;
  const cityId = context.req.query('cityId') || undefined;
  const city = context.req.query('city') || undefined;
  const cursor = context.req.query('cursor') || undefined;
  const limit = Number.parseInt(context.req.query('limit') || '100', 10);
  const residential = context.req.query('residential') === 'true';
  if (context.env.LOCATION_DB) {
    const catalog = await queryLocationCatalog(context.env.LOCATION_DB, {
      country: config.code,
      field,
      query,
      region,
      regionId,
      cityId,
      city,
      residential,
      cursor,
      limit
    });
    const responseData = {
      regions: field === 'region' ? catalog.options : [],
      cities: field === 'city' ? catalog.options : [],
      districts: field === 'district' ? catalog.options : [],
      postcodes: field === 'postcode' ? catalog.options : [],
      matches: catalog.options,
      total: catalog.total,
      availableTotal: catalog.availableTotal,
      nextCursor: catalog.nextCursor,
      revision: catalog.revision || '',
      source: catalog.source
    };
    context.header('X-Address-Catalog-Revision', catalog.revision || '');
    context.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    return context.json({ data: responseData });
  }
  if (field === 'region') {
    const regions = regionsForCountry(config.code, query);
    context.header('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
    return context.json({ data: { regions, cities: [], districts: [], postcodes: [], matches: regions } });
  }
  const cacheKey = locationCacheKey(config.code, field, residential, region, query, regionId, city, cityId, cursor, limit);
  const cached = readLocationCache<{ regions: ReturnType<typeof locationOptions>; cities: ReturnType<typeof locationOptions>; districts: ReturnType<typeof locationOptions>; postcodes: ReturnType<typeof locationOptions>; matches: ReturnType<typeof locationOptions> }>(cacheKey);
  if (cached) {
    context.header('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
    return context.json({ data: cached });
  }
  const normalizedQuery = query.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase();
  const cities = field === 'city' ? config.popularCities
    .filter((item) => !normalizedQuery || [item.value, item.label.en, item.label['zh-CN']].some((value) =>
      value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase().includes(normalizedQuery)))
    .map((item) => item.value) : [];
  const data = { regions: [], cities, postcodes: [], matches: cities };
  context.header('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
  const responseData = {
    regions: locationOptions(data.regions),
    cities: locationOptions(data.cities),
    districts: locationOptions([]),
    postcodes: locationOptions(data.postcodes),
    matches: locationOptions(data.matches)
  };
  writeLocationCache(cacheKey, responseData);
  return context.json({ data: responseData });
});

app.get('/api/v1/locations/hierarchy', async (context) => {
  if (!context.env.LOCATION_DB) throw new DomainError('DATABASE_UNAVAILABLE', 'The location catalog is unavailable.', 503);
  const country = context.req.query('country')?.toUpperCase() || '';
  if (!isCountryCode(country) || !countryByCode.has(country)) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${country}`);
  const childType = context.req.query('childType') || '';
  const parentType = context.req.query('parentType') || 'country';
  const parentId = context.req.query('parentId')?.trim() || '';
  if (!['region', 'city', 'district', 'postcode'].includes(childType)) {
    throw new DomainError('INVALID_FIELD', 'Unknown hierarchy child type.');
  }
  if (!['country', 'region', 'city'].includes(parentType)) {
    throw new DomainError('INVALID_LOCATION', 'Unknown hierarchy parent type.');
  }
  const allowedChildren: Record<string, string[]> = {
    country: ['region'], region: ['city', 'postcode'], city: ['district', 'postcode']
  };
  if (!allowedChildren[parentType].includes(childType) || (parentType !== 'country' && !parentId)) {
    throw new DomainError('INVALID_LOCATION', 'The requested parent and child hierarchy is not supported.');
  }
  const catalog = await queryLocationCatalog(context.env.LOCATION_DB, {
    country,
    field: childType as CatalogField,
    query: context.req.query('q')?.trim() || undefined,
    regionId: parentType === 'region' ? parentId : undefined,
    cityId: parentType === 'city' ? parentId : undefined,
    residential: country === 'CN' || context.req.query('residential') === 'true',
    cursor: context.req.query('cursor') || undefined,
    limit: Number.parseInt(context.req.query('limit') || '100', 10)
  });
  context.header('Cache-Control', 'no-store');
  return context.json({ data: {
    parent: { type: parentType, id: parentType === 'country' ? country : parentId },
    childType,
    children: catalog.options,
    total: catalog.total,
    availableTotal: catalog.availableTotal,
    nextCursor: catalog.nextCursor || null,
    source: catalog.source
  } });
});

app.get('/api/v1/generate', async (context) => {
  const startedAt = performance.now();
  const timings: GenerateTimings = { pool: 0, provider: 0, localize: 0 };
  const modeQuery = context.req.query('mode');
  const strategyQuery = context.req.query('strategy');
  const boundedQueries = [
    ['q', 300], ['region', 300], ['city', 300], ['district', 300], ['postcode', 300],
    ['regionId', 160], ['cityId', 160], ['districtId', 160], ['postcodeId', 160],
    ['seed', 300], ['requestId', 160], ['ip', 64]
  ] as const;
  if (modeQuery && modeQuery !== 'ip-region'
    || strategyQuery && !['random', 'instant'].includes(strategyQuery)
    || boundedQueries.some(([name, maximum]) => {
      const value = context.req.query(name);
      return value !== undefined && (value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value));
    })) {
    throw new DomainError('INVALID_GENERATION_REQUEST', 'Generation query parameters are invalid or too long.', 400);
  }
  const ipRegionMode = modeQuery === 'ip-region';
  const manualIp = context.req.query('ip');
  let ipContext: ClientContext | undefined;
  if (ipRegionMode) {
    if (manualIp !== undefined) {
      ipContext = await lookupManualIpContext(manualIp, context.env.IP_GEOLOCATION_API_URL, fetch, context.env.IP_GEOLOCATION_FALLBACK_API_URL);
    } else {
      ipContext = await locateRequestIp(context.req.raw, context.env);
    }
  }
  if (ipRegionMode && !ipContext?.country) {
    throw new DomainError('IP_LOCATION_UNAVAILABLE', 'No supported country was found for this IP location.', 400);
  }
  const countryCode = ipContext?.country || context.req.query('country')?.toUpperCase() || 'US';
  if (!isCountryCode(countryCode)) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${countryCode}`);
  const country = countryByCode.get(countryCode);
  if (!country) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${countryCode}`);

  const residentialQuery = context.req.query('residential');
  if (residentialQuery && !['true', 'false'].includes(residentialQuery)) {
    throw new DomainError('INVALID_RESIDENTIAL', 'Residential must be true or false.');
  }
  const residential = countryCode === 'CN' || residentialQuery === 'true';
  const seed = context.req.query('seed') || crypto.randomUUID();
  const strategy = strategyQuery === 'instant' ? 'instant' : 'random';
  const requestId = context.req.query('requestId') || crypto.randomUUID();
  const mode = ipRegionMode ? 'ip-region' : residential ? 'residential' : 'address';
  const cityId = context.req.query('cityId') || undefined;
  const cityFromId = decodeSyntheticCityId(cityId);
  if (cityId?.startsWith(CN_SYNTHETIC_CITY_PREFIX) && (!cityFromId || countryCode !== 'CN'
    || (context.req.query('city') && context.req.query('city')!.trim() !== cityFromId))) {
    throw new DomainError('INVALID_LOCATION', 'The selected city ID does not match the requested location.', 400);
  }
  const districtId = context.req.query('districtId') || undefined;
  const districtFromId = decodeSyntheticDistrict(districtId);
  if (districtId && (!districtFromId || countryCode !== 'CN')) {
    throw new DomainError('INVALID_LOCATION', 'The selected district ID is not present in the location catalog.', 400);
  }
  const requestedFilters: AddressFilters = {
    q: context.req.query('q') || undefined,
    region: context.req.query('region') || districtFromId?.province,
    regionId: context.req.query('regionId') || undefined,
    city: context.req.query('city') || cityFromId || districtFromId?.city,
    cityId,
    district: context.req.query('district') || districtFromId?.district,
    districtId,
    postcode: context.req.query('postcode') || undefined,
    postcodeId: context.req.query('postcodeId') || undefined
  };
  if ((requestedFilters.district || requestedFilters.districtId) && !country.addressSchema.filters.includes('district')) {
    throw new DomainError('INVALID_LOCATION', `District filtering is not supported for ${countryCode}.`, 400);
  }
  const filters: AddressFilters = ipRegionMode ? { q: requestedFilters.q } : requestedFilters;

  const hasLocationFilter = Boolean(
    filters.region || filters.regionId || filters.city || filters.cityId
    || filters.district || filters.districtId || filters.postcode || filters.postcodeId
  );
  const ipCoordinates = ipContext?.latitude !== undefined && ipContext.longitude !== undefined
    ? { latitude: ipContext.latitude, longitude: ipContext.longitude }
    : undefined;
  const ipLocationFilters: AddressFilters = {
    q: filters.q,
    region: ipContext?.regionCode || ipContext?.region,
    city: ipContext?.city,
    postcode: ipContext?.postalCode
  };
  let catalogLookupFailed = false;
  let target: CatalogTarget | undefined;
  try {
    const syntheticCity = !ipRegionMode && cityFromId;
    const catalogFilters = syntheticCity ? { ...filters, city: undefined, cityId: undefined } : filters;
    // Districts are matched by the pool itself; without a region, city or postcode there is nothing to resolve
    // in the catalog, and resolving anyway would pick an unrelated city.
    const lookupRequired = Boolean(filters.region || filters.regionId || filters.postcode || filters.postcodeId
      || (!syntheticCity && (filters.city || filters.cityId)));
    const nearestCatalog = ipRegionMode && ipCoordinates && context.env.LOCATION_DB
      ? await resolveNearestCatalogTarget(context.env.LOCATION_DB, country.code, ipCoordinates)
      : undefined;
    target = ipRegionMode
      ? nearestCatalog?.target || (context.env.LOCATION_DB
        ? await resolveCatalogTarget(context.env.LOCATION_DB, country.code, ipLocationFilters, seed)
        : undefined)
      : context.env.LOCATION_DB && lookupRequired
        ? await resolveCatalogTarget(context.env.LOCATION_DB, country.code, catalogFilters, seed)
        : undefined;
    if (syntheticCity && (!lookupRequired || target)) {
      target = { regionAliases: [], ...target, city: syntheticCity, cityNative: syntheticCity,
        cityAliases: [syntheticCity], bucket: `city-${cityId}` };
    }
  } catch {
    catalogLookupFailed = true;
  }
  if (hasLocationFilter && catalogLookupFailed) {
    throw new DomainError('LOCATION_CATALOG_UNAVAILABLE', 'Location filters are temporarily unavailable. Please retry.', 503);
  }
  // Catalog identities enrich aliases; the published pool remains the authority
  // on whether a requested locality exists. Keep valid text filters usable when
  // the catalog stores an alternate name, while stable IDs still fail closed.
  if (!target && hasLocationFilter) target = {
    regionAliases: filters.region ? [filters.region] : [],
    cityAliases: filters.city ? [filters.city] : [],
    bucket: `filter-${countryCode}-${filters.city || filters.region || filters.postcode || ''}`
  };

  const sourcesTried: string[] = [];
  let pooledSource = '';
  let ipMatchLevel: 'coordinate' | 'city' | 'region' | 'country' | undefined;
  let ipDistanceKm: number | undefined;
  let filterMatchLevel: 'exact' | 'nearby' | 'region' | 'country' | undefined;
  let resolvedFilters = filters;
  let resolvedTarget = target;
  let eligibleCount: number | undefined;
  const pooled = await measureStage(timings, 'pool', async () => {
    if (country.code === 'CN' && residential) {
      const community = await toleratePoolFailure(() => pickChinaCommunityAddress(
        context.env.ADDRESS_DB,
        ipRegionMode ? ipLocationFilters : {
          ...filters,
          region: target?.regionNative || filters.region
            || (filters.regionId || filters.cityId ? target?.region : undefined),
          city: filters.city || (filters.cityId ? target?.cityNative || target?.city : undefined),
          postcode: filters.postcode || (filters.postcodeId ? target?.postcode : undefined)
        },
        seed,
        ipRegionMode ? ipCoordinates : undefined
      ));
      if (community) {
        pooledSource = 'china-map-community';
        if (ipRegionMode) ipMatchLevel = ipCoordinates ? 'coordinate' : 'city';
        else filterMatchLevel = 'exact';
        return community;
      }
      return undefined;
    }
    if (ipRegionMode) {
      if (ipCoordinates) {
        const nearest = await toleratePoolFailure(() => pickNearestAddressPoolV2Address(
          context.env.ADDRESS_DB,
          country.code,
          residential,
          ipCoordinates,
          seed,
          25
        ));
        if (nearest) {
          pooledSource = 'address-pool-v2';
          ipMatchLevel = 'coordinate';
          ipDistanceKm = nearest.distanceKm;
          return nearest.address;
        }
      }

      const cityFilters: AddressFilters = {
        q: filters.q,
        region: target?.region || ipContext?.regionCode || ipContext?.region,
        city: target?.city || ipContext?.city
      };
      if (cityFilters.city) {
        const cityAddress = await toleratePoolFailure(() => pickAddressPoolV2Address(
          context.env.ADDRESS_DB, country.code, residential, cityFilters, target, seed
        ));
        if (cityAddress) {
          pooledSource = 'address-pool-v2';
          ipMatchLevel = 'city';
          resolvedFilters = cityFilters;
          return cityAddress;
        }
      }

      // A city or coordinate match is required for IP mode. Returning a
      // region-wide or country-wide record would make the location claim
      // misleading, so an uncovered city is reported as no result.
      return undefined;
    }

    let current = await toleratePoolFailure(() =>
      pickAddressPoolV2Address(context.env.ADDRESS_DB, country.code, residential, filters, target, seed)
    );
    if (current) {
      pooledSource = 'address-pool-v2';
      filterMatchLevel = 'exact';
      return current;
    }
    // The location catalog can carry a coarser or differently named parent
    // region than the published pool. Keep the city request usable when the
    // exact city itself is published, and report the relaxed scope.
    if (filters.city && (filters.region || filters.regionId)) {
      const cityFilters: AddressFilters = { ...filters, region: undefined, regionId: undefined };
      const cityTarget: CatalogTarget | undefined = target ? { ...target, region: undefined, regionId: undefined, regionAliases: [] } : undefined;
      const cityAddress = await toleratePoolFailure(() =>
        pickAddressPoolV2Address(context.env.ADDRESS_DB, country.code, residential, cityFilters, cityTarget, seed)
      );
      if (cityAddress) {
        pooledSource = 'address-pool-v2';
        filterMatchLevel = 'region';
        resolvedFilters = cityFilters;
        resolvedTarget = cityTarget;
        return cityAddress;
      }
    }
    // Keep the legacy in-memory service as an opt-in compatibility fallback
    // for tests and deployments that explicitly provide it. Production no
    // longer starts that service, so normal reads remain DB-first.
    if (context.env.RANDOM_ADDRESS_SERVICE) {
      const indexed = await toleratePoolFailure(() => context.env.RANDOM_ADDRESS_SERVICE!.pick({
        countryCode: country.code,
        filters,
        target,
        seed
      }));
      if (indexed?.ready) {
        if (!indexed.result) return undefined;
        pooledSource = indexed.result.source;
        filterMatchLevel = 'exact';
        eligibleCount = indexed.result.eligibleCount;
        return indexed.result.address;
      }
    }
    // A location-filtered request is exact-or-empty. Nearby, region-only and
    // nationwide substitutions can silently return an address from the wrong
    // place, so they are deliberately excluded from the publication path.
    if (hasLocationFilter) return undefined;
    const nationwide = await toleratePoolFailure(() =>
      pickAddressPoolV2Address(context.env.ADDRESS_DB, country.code, residential, { q: filters.q }, undefined, seed)
    );
    if (nationwide) {
      pooledSource = 'address-pool-v2';
      filterMatchLevel = hasLocationFilter ? 'country' : 'exact';
      resolvedFilters = { q: filters.q };
      resolvedTarget = undefined;
      return nationwide;
    }
    return undefined;
  });
  if (pooled) {
    sourcesTried.push(pooledSource);
  }
  if (!pooled) {
    throw new DomainError(
      ipRegionMode ? 'IP_REGION_NO_RESULT' : 'NO_POOL_COVERAGE',
      ipRegionMode
        ? `No synchronized address is available for the IP region in ${countryCode}.`
        : `No synchronized address is available for the selected area in ${countryCode}.`,
      404
    );
  }

  const selectedCandidate = pooled;
  const result = generateBundle(selectedCandidate, residential, seed, undefined);
  context.header('Cache-Control', 'no-store');
  context.header('Server-Timing', serverTiming(startedAt, timings));
  const ipRegion = ipContext ? {
    source: ipContext.source,
    contextMatchLevel: ipContext.matchLevel,
    precisionLevel: ipContext.precisionLevel,
    targetRegion: selectedCandidate?.components.admin1 || resolvedTarget?.region,
    targetCity: selectedCandidate?.components.locality || resolvedTarget?.city,
    ...(ipDistanceKm === undefined ? {} : { distanceKm: Number(ipDistanceKm.toFixed(2)) })
  } : undefined;
  return context.json({
    data: {
      requestId,
      mode,
      strategy,
      country: countryCode,
      residential,
      filters: resolvedFilters,
      sourcesTried,
      ...(eligibleCount === undefined ? {} : { eligibleCount }),
      ...(ipRegionMode ? { ipMatchLevel, ipRegion } : { filterMatchLevel: filterMatchLevel || 'exact' }),
      result
    }
  });
});

app.post('/api/v1/generate/batch', async (context) => {
  const body = await context.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const filters = body?.filters as Record<string, unknown> | undefined;
  const options = body?.options as Record<string, unknown> | undefined;
  const count = body?.count;
  if (!body || Array.isArray(body) || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 50
    || !filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new DomainError('INVALID_BATCH_REQUEST', 'Count must be an integer from 1 through 50 and filters must be an object.', 400);
  }
  const allowedFilterNames = ['country', 'region', 'regionId', 'city', 'cityId', 'district', 'districtId', 'postcode', 'postcodeId', 'q', 'residential'] as const;
  const unknownBodyField = Object.keys(body).find((name) => !['count', 'filters', 'options', 'excludeAddressIds'].includes(name));
  const unknownFilter = Object.keys(filters).find((name) => !allowedFilterNames.includes(name as typeof allowedFilterNames[number]));
  if (unknownBodyField || unknownFilter) throw new DomainError('INVALID_BATCH_REQUEST', `Unknown batch field: ${unknownBodyField || `filters.${unknownFilter}`}.`, 400);
  const stringFilters: Record<string, string> = {};
  for (const name of allowedFilterNames) {
    const value = filters[name];
    if (value === undefined || value === null || value === '') continue;
    if (name === 'residential') {
      if (typeof value !== 'boolean') throw new DomainError('INVALID_BATCH_REQUEST', 'residential must be a boolean.', 400);
      stringFilters[name] = String(value);
      continue;
    }
    if (typeof value !== 'string' || value.length > 300) throw new DomainError('INVALID_BATCH_REQUEST', `${name} must be a string of at most 300 characters.`, 400);
    stringFilters[name] = value;
  }
  const countryCode = stringFilters.country?.toUpperCase() || '';
  if (!isCountryCode(countryCode) || !countryByCode.has(countryCode)) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${countryCode}`);
  stringFilters.country = countryCode;
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new DomainError('INVALID_BATCH_REQUEST', 'Options must be an object.', 400);
  const unknownOption = options && Object.keys(options).find((name) => !['unique', 'seed', 'strategy', 'requestId'].includes(name));
  if (unknownOption) throw new DomainError('INVALID_BATCH_REQUEST', `Unknown batch field: options.${unknownOption}.`, 400);
  const unique = options?.unique !== false;
  if (options?.unique !== undefined && typeof options.unique !== 'boolean') throw new DomainError('INVALID_BATCH_REQUEST', 'options.unique must be a boolean.', 400);
  const strategy = options?.strategy === undefined ? 'random' : options.strategy;
  if (!['random', 'instant'].includes(String(strategy))) throw new DomainError('INVALID_BATCH_REQUEST', 'options.strategy must be random or instant.', 400);
  const requestedSeed = options?.seed;
  const requestedId = options?.requestId;
  if (requestedSeed !== undefined && (typeof requestedSeed !== 'string' || requestedSeed.length > 300)) throw new DomainError('INVALID_BATCH_REQUEST', 'options.seed must be a string of at most 300 characters.', 400);
  if (requestedId !== undefined && (typeof requestedId !== 'string' || requestedId.length > 160)) throw new DomainError('INVALID_BATCH_REQUEST', 'options.requestId must be a string of at most 160 characters.', 400);
  const exclusions = body.excludeAddressIds === undefined ? [] : body.excludeAddressIds;
  if (!Array.isArray(exclusions) || exclusions.length > 500 || exclusions.some((value) => typeof value !== 'string' || value.length > 160)) {
    throw new DomainError('INVALID_BATCH_REQUEST', 'excludeAddressIds must contain at most 500 address ID strings.', 400);
  }

  const seed = typeof requestedSeed === 'string' && requestedSeed ? requestedSeed : crypto.randomUUID();
  const requestId = typeof requestedId === 'string' && requestedId ? requestedId : crypto.randomUUID();
  const requestSignal = context.req.raw.signal;
  const requestAbortError = () => requestSignal.reason || Object.assign(new Error('Request was aborted'), { name: 'AbortError', code: 'REQUEST_ABORTED' });
  const throwIfRequestAborted = () => { if (requestSignal.aborted) throw requestAbortError(); };
  const abortable = async <T,>(task: Promise<T>): Promise<T> => {
    if (requestSignal.aborted) throw requestAbortError();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(requestAbortError());
      requestSignal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([task, aborted]); }
    finally { if (onAbort) requestSignal.removeEventListener('abort', onAbort); }
  };
  const excluded = new Set(exclusions as string[]);
  const selected = new Set<string>();
  const results: GeneratedBundle[] = [];
  const maximumAttempts = Math.min(200, Math.max(
    Number(count) * (unique ? 6 : 1),
    Number(count) + Math.min(excluded.size, Number(count) * 4)
  ));
  const batchConcurrency = Math.max(1, Math.min(10, Number.parseInt(context.env.BATCH_GENERATION_CONCURRENCY || '4', 10) || 4));
  let attempts = 0;

  const generateOne = async (attempt: number): Promise<{ result?: GeneratedBundle; error?: { code: string; message: string; status: number } }> => {
    throwIfRequestAborted();
    const url = new URL('/api/v1/generate', 'http://address.internal');
    for (const [name, value] of Object.entries(stringFilters)) url.searchParams.set(name, value);
    url.searchParams.set('strategy', String(strategy));
    url.searchParams.set('seed', `${seed}:${attempt}`);
    url.searchParams.set('requestId', `${requestId}:${attempt + 1}`);
    const response = await withGenerationSlot(context.env, () => Promise.resolve(app.fetch(
      new Request(url, { signal: requestSignal }), context.env
    )));
    throwIfRequestAborted();
    const payload = await response.json() as {
      data?: { result?: GeneratedBundle };
      error?: { code?: string; message?: string } | string;
    };
    if (!response.ok) return { error: {
      code: typeof payload.error === 'string' ? payload.error : payload.error?.code || 'BATCH_GENERATION_FAILED',
      message: typeof payload.error === 'string' ? payload.error : payload.error?.message || 'Address generation failed.',
      status: response.status
    } };
    if (!payload.data?.result) return { error: {
      code: 'BATCH_GENERATION_FAILED', message: 'Address generation returned no result.', status: 502
    } };
    return { result: payload.data.result };
  };

  while (results.length < Number(count) && attempts < maximumAttempts) {
    throwIfRequestAborted();
    const roundSize = Math.min(batchConcurrency, maximumAttempts - attempts, Math.max(1, (Number(count) - results.length) * 2));
    const roundStart = attempts;
    attempts += roundSize;
    const round = await abortable(Promise.all(Array.from({ length: roundSize }, (_, index) => generateOne(roundStart + index))));
    const failure = round.find((item) => item.error)?.error;
    if (failure) throw new DomainError(failure.code, failure.message, failure.status);
    for (const item of round) {
      const result = item.result;
      const id = result?.address.id;
      if (!result || !id || excluded.has(id) || (unique && selected.has(id))) continue;
      selected.add(id);
      results.push(result);
      if (results.length >= Number(count)) break;
    }
  }
  if (!results.length) throw new DomainError('NO_POOL_COVERAGE', `No synchronized address is available for the selected area in ${countryCode}.`, 404);
  context.header('Cache-Control', 'no-store');
  return context.json({ data: {
    requestId,
    requestedCount: Number(count),
    returnedCount: results.length,
    unique,
    exhausted: results.length < Number(count),
    filters: stringFilters,
    results
  } });
});

app.get('/api/v1/addresses/:id', async (context) => {
  const id = (context.req.param('id') || '').trim();
  if (!id || id.length > 160) throw new DomainError('INVALID_ADDRESS_ID', 'A valid address ID is required.', 400);
  const address = await loadAddressPoolV2AddressById(context.env.ADDRESS_DB, id)
    || await loadChinaCommunityAddressById(context.env.ADDRESS_DB, id);
  if (!address) throw new DomainError('ADDRESS_NOT_FOUND', 'The address is not present in the published synchronized pool.', 404);
  context.header('Cache-Control', 'no-store');
  return context.json({ data: { address } });
});

app.get('/api/v1/coverage', async (context) => {
  if (!context.env.ADDRESS_DB) throw new DomainError('DATABASE_UNAVAILABLE', 'The synchronization database is unavailable.', 503);
  const requestedCountry = context.req.query('country')?.toUpperCase();
  if (requestedCountry && (!isCountryCode(requestedCountry) || !countryByCode.has(requestedCountry))) {
    throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${requestedCountry}`);
  }
  const includeCompleteValue = context.req.query('includeComplete');
  if (includeCompleteValue && !['true', 'false'].includes(includeCompleteValue)) {
    throw new DomainError('INVALID_INCLUDE_COMPLETE', 'includeComplete must be true or false.');
  }
  const includeComplete = includeCompleteValue !== 'false';
  const goals = [...(await cachedCountryGoals(context.env.ADDRESS_DB)).values()]
    .filter((goal) => goal.enabled && (!requestedCountry || goal.countryCode === requestedCountry) && (includeComplete || !goal.complete))
    .map((goal) => ({
      countryCode: goal.countryCode,
      complete: goal.complete,
      unmetRules: goal.unmetRules,
      rules: goal.rules
    }));
  context.header('Cache-Control', 'no-store');
  return context.json({ data: { countries: goals } });
});

const TRANSLATION_RATE_LIMIT = 30;
const translationRateBuckets = new Map<string, { count: number; resetAt: number }>();
const translationRateLimited = (ip: string, now = Date.now()): boolean => {
  const bucket = translationRateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    if (translationRateBuckets.size > 10_000) translationRateBuckets.clear();
    translationRateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > TRANSLATION_RATE_LIMIT;
};

app.post('/api/v1/address-translation', async (context) => {
  const ip = requestContext(context.req.raw, context.env).publicIp || 'local';
  if (!context.env.API_TOKEN_AUTHENTICATED && translationRateLimited(ip)) {
    context.header('Retry-After', '60');
    return context.json({ error: { code: 'RATE_LIMITED', message: 'Too many translation requests.' } }, 429);
  }
  const body = await context.req.json().catch(() => undefined) as { addressId?: unknown; targetLocale?: unknown } | undefined;
  const addressId = typeof body?.addressId === 'string' ? body.addressId.trim() : '';
  const targetLocale = body?.targetLocale;
  if (!addressId || addressId.length > 160 || !isTranslatableLocale(targetLocale)) {
    throw new DomainError('INVALID_TRANSLATION_REQUEST', 'A pool addressId and a translatable targetLocale are required.', 400);
  }
  const address = await loadAddressPoolV2AddressById(context.env.ADDRESS_DB, addressId)
    || await loadChinaCommunityAddressById(context.env.ADDRESS_DB, addressId);
  if (!address) throw new DomainError('ADDRESS_NOT_FOUND', 'The address is not present in the synchronized pool.', 404);
  const result = await translateAddressComponents(address, targetLocale, context.env, fetch);
  context.header('Cache-Control', 'no-store');
  if (result.status === 'translated') {
    return context.json({ data: { components: result.components, lines: result.lines, singleLine: result.singleLine } });
  }
  return context.json({ data: result.status === 'unavailable' ? { unavailable: true } : { fallback: true } });
});

app.get('/api/v1/data-health', async (context) => {
  const configuredCodes = (context.env.HOT_POOL_COUNTRIES || countries.map(({ code }) => code).join(','))
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const requiredCountries = [...new Set(configuredCodes.filter(isCountryCode))];
  const invalidCountries = [...new Set(configuredCodes.filter((code) => !isCountryCode(code)))];
  const parsedMinimum = Number(context.env.HOT_POOL_MIN_PER_SLOT || '1');
  const minimumPerSlot = Number.isInteger(parsedMinimum) && parsedMinimum > 0 ? parsedMinimum : 1;
  const configurationErrors = [
    ...(invalidCountries.length ? [`Unsupported HOT_POOL_COUNTRIES: ${invalidCountries.join(',')}`] : []),
    ...(!Number.isInteger(parsedMinimum) || parsedMinimum <= 0
      ? ['HOT_POOL_MIN_PER_SLOT must be a positive integer.']
      : [])
  ];
  const checkedAt = new Date().toISOString();
  const [poolCounts, poolV2Counts, coverage] = await Promise.all([
    addressPoolCounts(context.env.LOCATION_DB),
    addressPoolV2Counts(context.env.ADDRESS_DB),
    hotPoolCoverage(context.env.ADDRESS_DB, requiredCountries, minimumPerSlot)
  ]);
  const coverageByCountry = new Map(coverage.countries.map((item) => [item.country_code, item]));
  const missingCountries = requiredCountries.filter((code) => !coverageByCountry.get(code)?.slot_count);
  const perCountry = countries.map((country) => {
    const v1 = poolCounts.get(country.code) || 0;
    const v2 = poolV2Counts.get(country.code);
    const hotPool = coverageByCountry.get(country.code);
    const hotPoolSlots = Number(hotPool?.slot_count || 0);
    const readyHotPoolSlots = Number(hotPool?.ready_slot_count || 0);
    return {
      country: country.code,
      mode: v1 || v2?.total ? 'offline-first' : 'dynamic',
      addressPoolRecords: Math.max(v1, v2?.total || 0),
      addressPoolV1Records: v1,
      addressPoolV2Records: v2?.total || 0,
      residentialPoolRecords: v2?.residential || 0,
      residential: country.residentialCapability,
      hotPoolRequired: requiredCountries.includes(country.code),
      hotPoolSlots,
      readyHotPoolSlots,
      lowWaterSlots: hotPoolSlots - readyHotPoolSlots,
      hotPoolCoverageRate: hotPoolSlots ? readyHotPoolSlots / hotPoolSlots : 0
    };
  });
  const totalSlots = perCountry.reduce((total, item) => total + item.hotPoolSlots, 0);
  const readySlots = perCountry.reduce((total, item) => total + item.readyHotPoolSlots, 0);
  const lowWaterSlotCount = totalSlots - readySlots;
  const hotPoolAvailable = coverage.available;
  const status = hotPoolAvailable && !missingCountries.length && !lowWaterSlotCount && !configurationErrors.length
    ? 'ready'
    : 'degraded';
  context.header('Cache-Control', 'no-store');
  return context.json({
    data: {
      status,
      checkedAt,
      configuredCountries: countries.length,
      requiredCountries,
      minimumPerSlot,
      addressRecords: perCountry.reduce((total, item) => total + item.addressPoolRecords, 0),
      residentialRecords: perCountry.reduce((total, item) => total + item.residentialPoolRecords, 0),
      hotPool: {
        available: hotPoolAvailable,
        totalSlots,
        readySlots,
        lowWaterSlotCount,
        coverageRate: totalSlots ? readySlots / totalSlots : 0,
        missingCountries,
        lowWaterSlots: coverage.lowWaterSlots.map((slot) => ({
          coverageKey: slot.coverage_key,
          country: slot.country_code,
          region: slot.admin1_key,
          locality: slot.locality_key,
          propertyType: slot.property_type,
          activeCount: Number(slot.active_count || 0),
          minimumCount: Number(slot.minimum_count || 0),
          deficit: Math.max(0, Number(slot.minimum_count || 0) - Number(slot.active_count || 0)),
          refreshStatus: slot.refresh_status,
          expiresAt: slot.expires_at
        })),
        lowWaterSlotsTruncated: lowWaterSlotCount > coverage.lowWaterSlots.length
      },
      configurationErrors,
      providers: {
        hkAls: true,
        amap: Boolean(context.env.AMAP_API_KEY),
        geoapify: Boolean(context.env.GEOAPIFY_API_KEY),
        oneMap: Boolean(context.env.ONEMAP_ACCESS_TOKEN),
        googleTranslate: true,
        youdao: Boolean(context.env.YOUDAO_APP_KEY && context.env.YOUDAO_APP_SECRET)
      },
      perCountry
    }
  });
});

app.notFound((context) => context.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

app.onError((error, context) => {
  if (error instanceof ManualIpLookupError) {
    return context.json(
      { error: { code: error.code, message: error.message } },
      error.status
    );
  }
  if (error instanceof DomainError) {
    const status = [400, 404, 429, 502, 503].includes(error.status) ? error.status : 500;
    return context.json(
      { error: { code: error.code, message: error.message } },
      status as 400 | 404 | 429 | 500 | 502 | 503
    );
  }
  const code = String((error as { code?: unknown })?.code || '').toUpperCase();
  const errorName = error instanceof Error ? error.name : '';
  if (errorName === 'AbortError' || code === 'REQUEST_ABORTED') return new Response(null, { status: 499 });
  if (code === 'DATABASE_UNAVAILABLE' || code === 'ECONNRESET' || code === 'ECONNREFUSED'
    || code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'ENETUNREACH'
    || code === 'EHOSTUNREACH' || code === 'ERR_SOCKET_CLOSED' || code === 'CONNECTION_TERMINATED'
    || code === 'CONNECTION_CLOSED' || code === '57P01' || code === '57P02' || code === '57P03'
    || code === '53300' || code === '55006' || code === '55P03' || code === '57014'
    || code === '40001' || code === '40P01' || code.startsWith('08')) {
    return context.json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The service database is temporarily unavailable.' } }, 503);
  }
  console.error(error);
  return context.json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected service error' } }, 500);
});

export default app;
