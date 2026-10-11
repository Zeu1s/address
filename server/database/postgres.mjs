import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { ensureActiveCountryCursorIndex } from './active-country-index.mjs';
import { translationRecoverySchema, ensureTranslationStreetIndex, translationStreetIndexSql } from './translation-recovery-schema.mjs';
import { postcodeInferenceSchema } from './postcode-inference-schema.mjs';
import { deeplBudgetSchema } from '../credential-broker/deepl.mjs';
import { administrativeAssignmentSchema, administrativeRuntimeView } from './administrative-assignments.mjs';
import { translationRoutesSchema } from '../translation/routing.mjs';

const { Pool } = pg;
const addressSchemaUrl = new URL('./schema.sql', import.meta.url);
const controlSchemaUrl = new URL('../control/schema.sql', import.meta.url);
const ADDRESS_SCHEMA_VERSION = 31;
const CONTROL_SCHEMA_VERSION = 26;

const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
const databaseClosedError = () => Object.assign(new Error('PostgreSQL database is closed'), { code: 'DATABASE_CLOSED' });

const postgresOptions = (environment) => {
  const base = environment.POSTGRES_OPTIONS || '-c search_path=address,control,public';
  const workers = integer(environment.POSTGRES_MAX_PARALLEL_WORKERS_PER_GATHER, 0, 0, 16);
  return `${base} -c max_parallel_workers_per_gather=${workers}`;
};

export const postgresPoolOptions = (environment = process.env) => ({
  connectionString: environment.POSTGRES_URL || environment.DATABASE_URL,
  max: integer(environment.POSTGRES_POOL_MAX, 16, 1, 512),
  min: integer(environment.POSTGRES_POOL_MIN, 1, 0, 128),
  connectionTimeoutMillis: integer(environment.POSTGRES_CONNECT_TIMEOUT_MS, 10_000, 1_000, 120_000),
  idleTimeoutMillis: integer(environment.POSTGRES_IDLE_TIMEOUT_MS, 30_000, 1_000, 30 * 60_000),
  statement_timeout: integer(environment.POSTGRES_STATEMENT_TIMEOUT_MS, 30_000, 1_000, 30 * 60_000),
  application_name: environment.POSTGRES_APPLICATION_NAME || 'address',
  options: postgresOptions(environment)
});

export const createPostgresPool = (options = {}) => {
  const { environment, ...overrides } = options;
  const pool = new Pool({ ...postgresPoolOptions(environment), ...overrides });
  pool.on('error', (error) => console.error(JSON.stringify({
    event: 'postgres_idle_client_error', code: error.code || null, message: error.message
  })));
  return pool;
};

const upgradeStreetSchema = async (client, source) => {
  const view = source.match(/DROP VIEW IF EXISTS address_pool_runtime;[\s\S]*?WHERE address_pool.active = 1;/u)?.[0];
  if (!view) throw new Error('Street migration runtime view is missing');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL search_path TO address, public");
      await client.query("SET LOCAL lock_timeout TO '250ms'");
      await client.query("SET LOCAL statement_timeout TO '2s'");
      await client.query(`LOCK TABLE address_pool,residential_coverage,address_pool_runtime
        IN ACCESS EXCLUSIVE MODE NOWAIT`);
      await client.query(`ALTER TABLE address_pool ADD COLUMN IF NOT EXISTS match_level TEXT NOT NULL DEFAULT 'premise';
        ALTER TABLE address_pool ALTER COLUMN house_number SET DEFAULT '';
        ALTER TABLE address_pool DROP CONSTRAINT IF EXISTS address_pool_house_number_check;
        ALTER TABLE address_pool DROP CONSTRAINT IF EXISTS address_pool_match_level_check;
        ALTER TABLE address_pool ADD CONSTRAINT address_pool_match_level_check
          CHECK (match_level IN ('street','premise','subpremise')) NOT VALID;
        ALTER TABLE residential_coverage ADD COLUMN IF NOT EXISTS total_count INTEGER NOT NULL DEFAULT 0;`);
      await client.query(view);
      await client.query('COMMIT');
      break;
    } catch (error) {
      await client.query('ROLLBACK');
      if (!['55P03', '57014'].includes(error?.code) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  await client.query('BEGIN');
  await client.query('SET LOCAL search_path TO address, public');
  await client.query("SET LOCAL statement_timeout TO '5min'");
  await client.query("SET LOCAL lock_timeout TO '250ms'");
  await client.query(`UPDATE address_pool SET match_level='subpremise'
    WHERE match_level='premise' AND trim(component_variants_json::jsonb -> 'native' ->> 'unit') <> ''`);
  await client.query('UPDATE residential_coverage SET total_count=address_count WHERE total_count<address_count');
  await client.query('ALTER TABLE address_pool VALIDATE CONSTRAINT address_pool_match_level_check');
  await client.query(`INSERT INTO schema_migrations(version,applied_at) VALUES (24,CURRENT_TIMESTAMP::text)
    ON CONFLICT (version) DO NOTHING`);
  await client.query('COMMIT');
};

const upgradeCoverageIdentity = async (client) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO address, public');
      await client.query("SET LOCAL lock_timeout TO '250ms'");
      await client.query("SET LOCAL statement_timeout TO '2s'");
      await client.query('LOCK TABLE residential_coverage IN ACCESS EXCLUSIVE MODE NOWAIT');
      await client.query(`ALTER TABLE residential_coverage ADD COLUMN IF NOT EXISTS identity_key TEXT NOT NULL DEFAULT '';
        ALTER TABLE residential_coverage DROP CONSTRAINT IF EXISTS residential_coverage_pkey;
        ALTER TABLE residential_coverage ADD CONSTRAINT residential_coverage_pkey
          PRIMARY KEY (country_code,region_name,city_name,identity_key)`);
      await client.query(`INSERT INTO address.schema_migrations(version,applied_at) VALUES (27,CURRENT_TIMESTAMP::text)
        ON CONFLICT (version) DO NOTHING`);
      await client.query('COMMIT');
      return;
    } catch (error) {
      await client.query('ROLLBACK');
      if (!['55P03', '57014'].includes(error?.code) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
};

const upgradeAdministrativeRecovery = async (client, source) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO address, public');
      await client.query("SET LOCAL lock_timeout TO '250ms'");
      await client.query("SET LOCAL statement_timeout TO '3s'");
      await client.query(administrativeAssignmentSchema);
      await client.query(translationRecoverySchema);
      await client.query(administrativeRuntimeView(source));
      await client.query(`INSERT INTO schema_migrations(version,applied_at) VALUES (28,CURRENT_TIMESTAMP::text) ON CONFLICT(version) DO NOTHING`);
      await client.query('COMMIT');
      return;
    } catch (error) {
      await client.query('ROLLBACK');
      if (!['55P03', '57014'].includes(error?.code) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
};

const canonicalIndexState = async (client) => {
  const { rows: [index] } = await client.query(`SELECT
      index_state.indisvalid AS valid, index_state.indisready AS ready, index_state.indislive AS live,
      index_relation.relkind='i' AND table_schema.nspname='address' AND table_relation.relname='address_pool'
        AND access_method.amname='btree' AND NOT index_state.indisunique AND NOT index_state.indisexclusion
        AND index_state.indnkeyatts=2 AND index_state.indnatts=2
        AND pg_get_indexdef(index_state.indexrelid,1,true)='country_code'
        AND pg_get_indexdef(index_state.indexrelid,2,true)='canonical_key' AS expected_definition,
      pg_get_expr(index_state.indpred,index_state.indrelid) AS predicate
    FROM pg_class index_relation
    JOIN pg_namespace index_schema ON index_schema.oid=index_relation.relnamespace
    LEFT JOIN pg_index index_state ON index_state.indexrelid=index_relation.oid
    LEFT JOIN pg_class table_relation ON table_relation.oid=index_state.indrelid
    LEFT JOIN pg_namespace table_schema ON table_schema.oid=table_relation.relnamespace
    LEFT JOIN pg_am access_method ON access_method.oid=index_relation.relam
    WHERE index_schema.nspname='address' AND index_relation.relname='idx_address_pool_canonical_key'`);
  if (index && index.expected_definition === false) throw new Error('Unexpected definition for address.idx_address_pool_canonical_key; refusing modification');
  if (index?.predicate) {
    const predicate = String(index.predicate).replace(/::text/gu, '').replace(/\s+/gu, ' ').trim();
    if (predicate !== "(canonical_key <> '')") throw new Error('Unexpected predicate for address.idx_address_pool_canonical_key; refusing modification');
  }
  return index;
};

const upgradePostcodeInferenceSchema = async (client) => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path TO address, public');
    await client.query("SET LOCAL lock_timeout TO '5min'");
    await client.query("SET LOCAL statement_timeout TO '2min'");
    await client.query(postcodeInferenceSchema);
    await client.query(`INSERT INTO schema_migrations(version,applied_at) VALUES (31,CURRENT_TIMESTAMP::text) ON CONFLICT(version) DO NOTHING`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
};

const upgradeChinaPublicationSchema = async (client) => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path TO address, public');
    await client.query("SET LOCAL lock_timeout TO '5min'");
    await client.query("SET LOCAL statement_timeout TO '10min'");
    await client.query(`ALTER TABLE cn_communities_v2 ADD COLUMN IF NOT EXISTS postcode TEXT NOT NULL DEFAULT '';
      ALTER TABLE cn_community_sources ADD COLUMN IF NOT EXISTS accepted_strategy_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE cn_ingest_candidates ADD COLUMN IF NOT EXISTS postcode TEXT NOT NULL DEFAULT '';
      ALTER TABLE cn_sync_checkpoints ADD COLUMN IF NOT EXISTS page_signature TEXT`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }

  const { rows: [settings] } = await client.query(`SELECT current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout`);
  try {
    await client.query("SET statement_timeout TO '30min'");
    await client.query("SET lock_timeout TO '5min'");
    for (const index of [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cn_communities_postcode ON address.cn_communities_v2(postcode,active)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cn_communities_city_random ON address.cn_communities_v2(city,active,((hashtextextended(id,0) & 2147483647)),id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cn_communities_province_random ON address.cn_communities_v2(province,active,((hashtextextended(id,0) & 2147483647)),id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cn_communities_district_random ON address.cn_communities_v2(district,active,((hashtextextended(id,0) & 2147483647)),id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cn_communities_postcode_random ON address.cn_communities_v2(postcode,active,((hashtextextended(id,0) & 2147483647)),id)'
    ]) await client.query(index);
  } finally {
    await client.query('SELECT set_config(\'statement_timeout\',$1,false),set_config(\'lock_timeout\',$2,false)', [
      settings.statement_timeout, settings.lock_timeout
    ]);
  }

  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path TO address, public');
    await client.query("SET LOCAL lock_timeout TO '2s'");
    await client.query("SET LOCAL statement_timeout TO '30s'");
    await client.query(`INSERT INTO schema_migrations(version,applied_at) VALUES (30,CURRENT_TIMESTAMP::text)
      ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
};

const upgradeCanonicalAddressIdentity = async (client) => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path TO address, public');
    await client.query("SET LOCAL lock_timeout TO '5min'");
    await client.query("SET LOCAL statement_timeout TO '10min'");
    const column = await client.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='address' AND table_name='address_pool' AND column_name='canonical_key'`);
    if (!column.rows.length) await client.query("ALTER TABLE address_pool ADD COLUMN canonical_key TEXT NOT NULL DEFAULT ''");
    await client.query("SET LOCAL statement_timeout TO '30min'");
    await client.query(`UPDATE address_pool SET canonical_key=lower(concat_ws(chr(31),
      CASE WHEN match_level='street' THEN 'street' ELSE 'premise' END,country_code,
      coalesce(nullif(admin1_code,''),admin1,''),coalesce(nullif(locality,''),postal_locality,''),
      coalesce(district,''),postcode,street,house_number,
      coalesce(component_variants_json::jsonb -> 'native' ->> 'unit','')))
      WHERE canonical_key=''`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  let index = await canonicalIndexState(client);
  if (index && !(index.valid && index.ready && index.live)) {
    await client.query('DROP INDEX CONCURRENTLY address.idx_address_pool_canonical_key');
    index = null;
  }
  if (!index) {
    await client.query(`CREATE INDEX CONCURRENTLY idx_address_pool_canonical_key
      ON address.address_pool(country_code,canonical_key) WHERE canonical_key <> ''`);
    index = await canonicalIndexState(client);
  }
  if (!index || !(index.valid && index.ready && index.live)) {
    throw new Error('Canonical address identity index did not become valid');
  }
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path TO address, public");
    await client.query(`INSERT INTO schema_migrations(version,applied_at) VALUES (29,CURRENT_TIMESTAMP::text)
      ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
};

const controlQueueSnapshotMigration = `
  ALTER TABLE sync_scheduler_state ADD COLUMN IF NOT EXISTS queue_snapshot_json TEXT;
  ALTER TABLE sync_scheduler_state ADD COLUMN IF NOT EXISTS queue_snapshot_at TEXT;
  UPDATE provider_quota_windows SET limit_count=100000000,updated_at=CURRENT_TIMESTAMP::text
  WHERE limit_count=100 AND credential_id IN (SELECT id FROM provider_credentials WHERE provider='onemap');
  UPDATE provider_credentials SET daily_limit=100000000,quota_limit=100000000,updated_at=CURRENT_TIMESTAMP::text
  WHERE provider='onemap' AND quota_limit=100;
  DELETE FROM provider_quota_windows
  WHERE credential_id IN (SELECT id FROM provider_credentials WHERE provider='google-geocoding')
    AND service='geocode-v4' AND period='day' AND limit_count=1000;
  UPDATE provider_credentials SET qps_limit=5,daily_limit=10000,quota_period='month',quota_limit=10000,
    quota_timezone_offset=-480,updated_at=CURRENT_TIMESTAMP::text
  WHERE provider='google-geocoding' AND quota_period='day' AND quota_limit=1000;
`;

export const initializePostgres = async (pool, {
  addressSchema = addressSchemaUrl,
  controlSchema = controlSchemaUrl
} = {}) => {
  const [addressSource, controlSource] = await Promise.all([
    readFile(addressSchema instanceof URL ? fileURLToPath(addressSchema) : addressSchema, 'utf8'),
    readFile(controlSchema instanceof URL ? fileURLToPath(controlSchema) : controlSchema, 'utf8')
  ]);
  const client = await pool.connect();
  try {
    try {
      const { rows: [versions] } = await client.query(`
        SELECT
          (SELECT COALESCE(MAX(version), 0) FROM address.schema_migrations) AS address_version,
          (SELECT COALESCE(MAX(version), 0) FROM control.control_migrations) AS control_version
      `);
      if (Number(versions.address_version) >= ADDRESS_SCHEMA_VERSION
        && Number(versions.control_version) >= CONTROL_SCHEMA_VERSION) return;
      if ([23, 24, 25, 26, 27, 28, 29, 30, 31].includes(Number(versions.address_version))
        && Number(versions.control_version) >= 19) {
        if (Number(versions.address_version) === 23) await upgradeStreetSchema(client, addressSource);
        if (Number(versions.address_version) < 25) await ensureActiveCountryCursorIndex(client);
        if (Number(versions.address_version) < 26) await ensureTranslationStreetIndex(client);
        if (Number(versions.address_version) < 27) await upgradeCoverageIdentity(client);
        if (Number(versions.address_version) < 28) await upgradeAdministrativeRecovery(client, addressSource);
        if (Number(versions.address_version) < 29) await upgradeCanonicalAddressIdentity(client);
        if (Number(versions.address_version) < 30) await upgradeChinaPublicationSchema(client);
        if (Number(versions.address_version) < 31) await upgradePostcodeInferenceSchema(client);
        await client.query('BEGIN');
        await client.query('SET LOCAL search_path TO address, public');
        await client.query("SET LOCAL lock_timeout TO '2s'");
        await client.query("SET LOCAL statement_timeout TO '30s'");
        await client.query(translationRecoverySchema);
        await client.query(`INSERT INTO address.schema_migrations(version,applied_at) VALUES (25,CURRENT_TIMESTAMP::text),(26,CURRENT_TIMESTAMP::text)
          ON CONFLICT (version) DO NOTHING`);
        await client.query('COMMIT');
        if (Number(versions.control_version) < 20) {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout TO '250ms'");
          await client.query("SET LOCAL statement_timeout TO '2s'");
          await client.query(`ALTER TABLE control.credential_broker_requests
            DROP CONSTRAINT IF EXISTS credential_broker_requests_provider_check;
            ALTER TABLE control.credential_broker_requests ADD CONSTRAINT credential_broker_requests_provider_check
            CHECK (provider IN ('amap','baidu','tencent','onemap','geoapify','google-geocoding','mappls','youdao')) NOT VALID`);
          await client.query('COMMIT');
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout TO '250ms'");
          await client.query("SET LOCAL statement_timeout TO '30s'");
          await client.query('ALTER TABLE control.credential_broker_requests VALIDATE CONSTRAINT credential_broker_requests_provider_check');
          await client.query(`INSERT INTO control.control_migrations(version,applied_at) VALUES (20,CURRENT_TIMESTAMP::text)
            ON CONFLICT (version) DO NOTHING`);
          await client.query('COMMIT');
        }
        if (Number(versions.control_version) < 21) {
          await client.query('BEGIN');
          await client.query('SET LOCAL search_path TO control, public');
          await client.query("SET LOCAL lock_timeout TO '250ms'");
          await client.query("SET LOCAL statement_timeout TO '2s'");
          await client.query(deeplBudgetSchema);
          for (const table of ['provider_credentials', 'credential_broker_requests']) {
            await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_provider_check;
              ALTER TABLE ${table} ADD CONSTRAINT ${table}_provider_check
              CHECK (provider IN ('amap','baidu','tencent','onemap','youdao','geoapify','google-geocoding','mappls','deepl')) NOT VALID`);
          }
          await client.query('COMMIT');
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout TO '250ms'");
          await client.query("SET LOCAL statement_timeout TO '30s'");
          for (const table of ['provider_credentials', 'credential_broker_requests']) {
            await client.query(`ALTER TABLE control.${table} VALIDATE CONSTRAINT ${table}_provider_check`);
          }
          await client.query(`INSERT INTO control.control_migrations(version,applied_at) VALUES (21,CURRENT_TIMESTAMP::text)
            ON CONFLICT (version) DO NOTHING`);
          await client.query('COMMIT');
        }
        if (Number(versions.control_version) < 22) {
          await client.query('BEGIN');
          await client.query('SET LOCAL search_path TO control, public');
          await client.query("SET LOCAL lock_timeout TO '2s'");
          await client.query("SET LOCAL statement_timeout TO '30s'");
          await client.query("ALTER TABLE credential_broker_dispatches ADD COLUMN IF NOT EXISTS credential_revision TEXT NOT NULL DEFAULT ''");
          await client.query(`INSERT INTO control_migrations(version,applied_at) VALUES (22,CURRENT_TIMESTAMP::text)
            ON CONFLICT (version) DO NOTHING`);
          await client.query('COMMIT');
        }
        if (Number(versions.control_version) < 23) {
          await client.query('BEGIN');
          await client.query('SET LOCAL search_path TO control, public');
          await client.query("SET LOCAL lock_timeout TO '250ms'");
          await client.query("SET LOCAL statement_timeout TO '2s'");
          for (const table of ['provider_credentials', 'credential_broker_requests']) {
            await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_provider_check;
              ALTER TABLE ${table} ADD CONSTRAINT ${table}_provider_check
              CHECK (provider IN ('amap','baidu','tencent','onemap','youdao','geoapify','google-geocoding','mappls','deepl','openai-compatible')) NOT VALID`);
          }
          await client.query('COMMIT');
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout TO '250ms'");
          await client.query("SET LOCAL statement_timeout TO '30s'");
          for (const table of ['provider_credentials', 'credential_broker_requests']) {
            await client.query(`ALTER TABLE control.${table} VALIDATE CONSTRAINT ${table}_provider_check`);
          }
          await client.query(`INSERT INTO control.control_migrations(version,applied_at) VALUES (23,CURRENT_TIMESTAMP::text)
            ON CONFLICT (version) DO NOTHING`);
          await client.query('COMMIT');
        }
        if (Number(versions.control_version) < 24) {
          await client.query('BEGIN');
          await client.query('SET LOCAL search_path TO control, public');
          await client.query("SET LOCAL lock_timeout TO '250ms'");
          await client.query("SET LOCAL statement_timeout TO '30s'");
          await client.query(translationRoutesSchema);
          await client.query(`INSERT INTO translation_routes(id,provider,credential_id,priority,enabled,prompt,created_at,updated_at)
            VALUES ('deepl','deepl',NULL,20,1,'',CURRENT_TIMESTAMP::text,CURRENT_TIMESTAMP::text),
              ('youdao','youdao',NULL,30,1,'',CURRENT_TIMESTAMP::text,CURRENT_TIMESTAMP::text),
              ('google','google',NULL,40,1,'',CURRENT_TIMESTAMP::text,CURRENT_TIMESTAMP::text)
            ON CONFLICT (id) DO NOTHING`);
          await client.query(`INSERT INTO translation_routes(id,provider,credential_id,priority,enabled,prompt,created_at,updated_at)
            SELECT 'openai:'||id,'openai-compatible',id,10,enabled,'',created_at,updated_at
            FROM provider_credentials WHERE provider='openai-compatible'
            ON CONFLICT (id) DO NOTHING`);
          await client.query(`INSERT INTO control.control_migrations(version,applied_at) VALUES (24,CURRENT_TIMESTAMP::text)
            ON CONFLICT (version) DO NOTHING`);
          await client.query('COMMIT');
        }
        if (Number(versions.control_version) < 25) {
          await client.query('BEGIN');
          await client.query('SET LOCAL search_path TO control, public');
          await client.query("SET LOCAL lock_timeout TO '2s'");
          await client.query("SET LOCAL statement_timeout TO '30s'");
          await client.query(controlQueueSnapshotMigration);
          await client.query(`INSERT INTO control.control_migrations(version,applied_at) VALUES (25,CURRENT_TIMESTAMP::text)
            ON CONFLICT (version) DO NOTHING`);
          await client.query('COMMIT');
        }
        if (Number(versions.control_version) < 26) {
          // The live broker locks credential rows briefly on every reservation; retry short lock windows between them.
          await client.query("SET lock_timeout TO '1s'");
          for (let attempt = 1; ; attempt += 1) {
            try {
              await client.query('ALTER TABLE control.provider_credentials ADD COLUMN IF NOT EXISTS max_concurrency INTEGER NOT NULL DEFAULT 1');
              break;
            } catch (error) {
              if (error?.code !== '55P03' || attempt >= 60) throw error;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
          await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credential_broker_dispatches_in_flight
            ON control.credential_broker_dispatches(credential_id,status,reserved_at)`);
          await client.query('RESET lock_timeout');
          await client.query(`INSERT INTO control.control_migrations(version,applied_at) VALUES (26,CURRENT_TIMESTAMP::text)
            ON CONFLICT (version) DO NOTHING`);
        }
        return;
      }
    } catch (error) {
      if (!['3F000', '42P01'].includes(error?.code)) throw error;
    }
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout TO '30min'");
    await client.query("SET LOCAL lock_timeout TO '5min'");
    await client.query('CREATE SCHEMA IF NOT EXISTS address');
    await client.query('CREATE SCHEMA IF NOT EXISTS control');
    await client.query('SET LOCAL search_path TO address, public');
    await client.query(addressSource);
    await client.query(administrativeAssignmentSchema);
    await client.query(administrativeRuntimeView(addressSource));
    await client.query(translationRecoverySchema);
    await client.query(translationStreetIndexSql);
    await client.query('SET LOCAL search_path TO control, public');
    await client.query(controlSource);
    await client.query(deeplBudgetSchema);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const rewritePlaceholders = (source) => {
  let output = '';
  let quote = '';
  let parameter = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      output += character;
      if (character === quote) {
        if (source[index + 1] === quote) output += source[++index];
        else quote = '';
      }
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      output += character;
    } else if (character === '?') {
      output += `$${++parameter}`;
    } else output += character;
  }
  return output;
};

class PostgresPreparedStatement {
  constructor(database, query, bindings = []) {
    this.database = database;
    this.query = rewritePlaceholders(String(query));
    this.bindings = bindings;
  }

  bind(...values) {
    return new PostgresPreparedStatement(this.database, this.query, values);
  }

  async all() {
    const startedAt = performance.now();
    const result = await this.database.query(this.query, this.bindings);
    return {
      success: true,
      results: result.rows,
      meta: {
        duration: performance.now() - startedAt,
        changes: result.rowCount || 0,
        last_row_id: 0,
        rows_read: result.rows.length,
        rows_written: 0
      }
    };
  }

  async first(columnName) {
    const result = await this.database.query(this.query, this.bindings);
    const row = result.rows[0] || null;
    return row && columnName !== undefined ? row[columnName] ?? null : row;
  }

  async run() {
    const startedAt = performance.now();
    const result = await this.database.query(this.query, this.bindings);
    return {
      success: true,
      results: result.rows,
      meta: {
        duration: performance.now() - startedAt,
        changes: result.rowCount || 0,
        last_row_id: 0,
        rows_read: result.rows.length,
        rows_written: result.rowCount || 0
      }
    };
  }

  async raw(options = {}) {
    const result = await this.database.query(this.query, this.bindings);
    const columns = result.fields.map(({ name }) => name);
    const rows = result.rows.map((row) => columns.map((column) => row[column]));
    return options.columnNames ? [columns, ...rows] : rows;
  }
}

export class PostgresDatabase {
  constructor(pool, { ownsPool = false } = {}) {
    this.pool = pool;
    this.ownsPool = ownsPool;
    this.dialect = 'postgres';
    this.transactions = new AsyncLocalStorage();
    this.activeTransactions = new Set();
    this.closePromise = null;
    this.closing = false;
    this.closed = false;
  }

  prepare(query) {
    return new PostgresPreparedStatement(this, query);
  }

  query(query, bindings) {
    const parameters = String(query).match(/\$\d+/gu)?.length || 0;
    if (parameters !== (bindings || []).length) {
      if (process.env.DEBUG_PG_BIND === '1') {
        console.error('[pg-bind]', JSON.stringify({
          parameters, bindings: (bindings || []).length,
          sql: String(query).replace(/\s+/gu, ' ').slice(0, 500)
        }));
      }
      throw Object.assign(new Error(
        `PostgreSQL statement expects ${parameters} parameters but received ${(bindings || []).length}`
      ), { code: 'PG_PARAMETER_MISMATCH', sql: String(query).replace(/\s+/gu, ' ').slice(0, 400) });
    }
    const transaction = this.transactions.getStore();
    if (transaction) {
      if (!transaction.active || transaction.closing) throw databaseClosedError();
      return transaction.client.query(query, bindings).catch((error) => {
        if (process.env.DEBUG_PG_BIND === '1' && /bind message supplies/iu.test(error?.message || '')) {
          console.error('[pg-bind]', JSON.stringify({ sql: String(query), bindings: (bindings || []).length }));
        }
        throw error;
      });
    }
    if (this.closing || this.closed) throw databaseClosedError();
    return this.pool.query(query, bindings).catch((error) => {
      if (process.env.DEBUG_PG_BIND === '1' && /bind message supplies/iu.test(error?.message || '')) {
        console.error('[pg-bind]', JSON.stringify({ sql: String(query), bindings: (bindings || []).length }));
      }
      throw error;
    });
  }

  async batch(statements) {
    const transaction = this.transactions.getStore();
    if (transaction) {
      if (!transaction.active || transaction.closing) throw databaseClosedError();
      const results = [];
      for (const statement of statements) {
        results.push(await new PostgresPreparedStatement(this, statement.query, statement.bindings).run());
      }
      return results;
    }
    if (this.closing || this.closed) throw databaseClosedError();
    const client = await this.pool.connect();
    const database = new PostgresDatabase(client);
    let discard = false;
    let started = false;
    try {
      await client.query('BEGIN');
      started = true;
      const results = [];
      for (const statement of statements) {
        results.push(await new PostgresPreparedStatement(
          database, statement.query, statement.bindings
        ).run());
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      if (started) await client.query('ROLLBACK').catch(() => { discard = true; });
      else discard = true;
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async exec(query) {
    const startedAt = performance.now();
    const normalized = String(query).trim();
    if (!normalized) return { count: 0, duration: performance.now() - startedAt };
    if (/^(BEGIN|COMMIT|ROLLBACK)\s*;?$/iu.test(normalized)) {
      throw new Error('Use database.transaction() for PostgreSQL transactions');
    }
    const result = await this.query(normalized);
    return { count: result.rowCount || 0, duration: performance.now() - startedAt };
  }

  async transaction(work, { signal } = {}) {
    if (this.transactions.getStore()?.active) {
      throw new Error('PostgreSQL transaction is already active');
    }
    if (this.closing || this.closed) throw databaseClosedError();
    const client = await this.pool.connect();
    if (this.closing || this.closed) {
      client.release(true);
      throw databaseClosedError();
    }
    const transaction = {
      client, active: false, closing: false, started: false, rolledBack: false,
      released: false, rollbackPromise: null
    };
    transaction.rollback = async () => {
      if (!transaction.rollbackPromise) {
        transaction.rollbackPromise = (async () => {
          try { await client.query('ROLLBACK'); }
          finally { transaction.rolledBack = true; }
        })();
      }
      return transaction.rollbackPromise;
    };
    transaction.release = (discard = false) => {
      if (transaction.released) return;
      transaction.released = true;
      client.release(discard);
    };
    this.activeTransactions.add(transaction);
    let started = false;
    let discard = false;
    // Cancelling the caller also cancels the statement running on this connection; checks between statements alone
    // left long imports running for minutes after a job was cancelled.
    let cancelStatement;
    try {
      if (transaction.closing) throw databaseClosedError();
      signal?.throwIfAborted();
      await client.query('BEGIN');
      started = true;
      transaction.started = true;
      transaction.active = true;
      if (signal) {
        const pid = (await client.query('SELECT pg_backend_pid() AS pid').catch(() => null))?.rows?.[0]?.pid;
        if (pid) {
          cancelStatement = () => { this.pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {}); };
          signal.addEventListener('abort', cancelStatement, { once: true });
        }
      }
      return await this.transactions.run(transaction, async () => {
        if (transaction.closing) throw databaseClosedError();
        const result = await work(this);
        if (transaction.closing) throw databaseClosedError();
        try { await client.query('COMMIT'); }
        catch (error) { discard = true; throw error; }
        return result;
      });
    } catch (error) {
      if (started && !transaction.rolledBack && !discard) {
        await transaction.rollback().catch(() => { discard = true; });
      }
      else if (!started) discard = true;
      throw error;
    } finally {
      if (cancelStatement) signal.removeEventListener('abort', cancelStatement);
      transaction.active = false;
      this.activeTransactions.delete(transaction);
      transaction.release(discard || transaction.closing);
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const transactions = [...this.activeTransactions];
      await Promise.allSettled(transactions.map(async (transaction) => {
        transaction.closing = true;
        transaction.active = false;
        try { await transaction.rollback(); }
        finally {
          transaction.release(true);
          this.activeTransactions.delete(transaction);
        }
      }));
      this.closed = true;
      if (this.ownsPool) await this.pool.end();
    })();
    return this.closePromise;
  }
}

export const openPostgresDatabase = async (options = {}) => {
  const pool = options.pool || createPostgresPool(options);
  if (options.migrate !== false) await initializePostgres(pool, options);
  return new PostgresDatabase(pool, { ownsPool: !options.pool });
};
