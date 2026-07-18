// Concrete Postgres RepositoryFactory. Bridges the app row types
// (repositories.ts) onto the migration schema: natural columns map directly,
// app-specific extras ride in each table's `metadata` JSONB under key "app".
// Idempotent writes use ON CONFLICT on each table's natural key.

import pg from 'pg';
import type {
  AbstentionRow,
  AbstentionsRepository,
  AssetsRepository,
  CandleRow,
  CandlesRepository,
  CatalystRow,
  CatalystsRepository,
  EvidenceRefRow,
  EvidenceRefsRepository,
  GradeRow,
  GradeStats,
  GradesRepository,
  JobRow,
  JobsRepository,
  ObservationRow,
  ObservationsRepository,
  OutboxRepository,
  OutboxRow,
  PositioningEventRow,
  PositioningEventsRepository,
  RawSnapshotRow,
  RawSnapshotsRepository,
  RepositoryFactory,
  SignalRow,
  SignalsRepository,
  SocialClaimRow,
  SocialClaimsRepository,
  SourceHealthRepository,
  SourceHealthRow,
} from './repositories.js';
import type { Asset } from '@contracts/core';

const { Pool } = pg;

type Q = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<pg.QueryResult<T>>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const reqNum = (v: unknown): number => Number(v);

function venueFromUid(uid: string): string {
  if (uid.startsWith('crypto:hl:')) return 'hyperliquid';
  if (uid.startsWith('stock:us:')) return 'alpaca';
  return 'unknown';
}
function symbolFromUid(uid: string): string {
  const parts = uid.split(':');
  return parts[parts.length - 1] ?? uid;
}

/** Ensure the assets FK target exists before dependent inserts. */
async function ensureAsset(q: Q, assetUid: string, symbol?: string, venue?: string): Promise<void> {
  await q(
    `INSERT INTO assets (asset_uid, symbol, name, asset_type, venue)
     VALUES ($1, $2, $2, $3, $4)
     ON CONFLICT (asset_uid) DO NOTHING`,
    [
      assetUid,
      symbol ?? symbolFromUid(assetUid),
      assetUid.startsWith('stock:') ? 'stock' : 'crypto',
      venue ?? venueFromUid(assetUid),
    ],
  );
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

class PgAssets implements AssetsRepository {
  constructor(private q: Q) {}

  private fromDb(r: pg.QueryResultRow): Asset {
    return {
      id: r.asset_uid,
      symbol: r.symbol,
      name: r.name,
      type: r.asset_type,
      decimals: r.decimals ?? undefined,
    };
  }
  async findById(id: string) {
    const r = await this.q('SELECT * FROM assets WHERE asset_uid = $1', [id]);
    return r.rows[0] ? this.fromDb(r.rows[0]) : null;
  }
  async findAll() {
    return (await this.q('SELECT * FROM assets ORDER BY asset_uid')).rows.map((r) => this.fromDb(r));
  }
  async insert(a: Asset) {
    await this.q(
      `INSERT INTO assets (asset_uid, symbol, name, asset_type, venue, decimals)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.id, a.symbol, a.name, a.type, venueFromUid(a.id), a.decimals ?? null],
    );
    return a;
  }
  async update(a: Asset) {
    await this.q(
      `UPDATE assets SET symbol=$2, name=$3, asset_type=$4, decimals=$5, updated_at=NOW()
       WHERE asset_uid=$1`,
      [a.id, a.symbol, a.name, a.type, a.decimals ?? null],
    );
    return a;
  }
  async delete(id: string) {
    return ((await this.q('DELETE FROM assets WHERE asset_uid=$1', [id])).rowCount ?? 0) > 0;
  }
  async exists(id: string) {
    return ((await this.q('SELECT 1 FROM assets WHERE asset_uid=$1', [id])).rowCount ?? 0) > 0;
  }
  async upsert(a: Asset) {
    await this.q(
      `INSERT INTO assets (asset_uid, symbol, name, asset_type, venue, decimals)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (asset_uid) DO UPDATE SET symbol=EXCLUDED.symbol, name=EXCLUDED.name,
         asset_type=EXCLUDED.asset_type, decimals=EXCLUDED.decimals, updated_at=NOW()`,
      [a.id, a.symbol, a.name, a.type, venueFromUid(a.id), a.decimals ?? null],
    );
    return a;
  }
  async findBySymbol(symbol: string, venue: string) {
    const r = await this.q('SELECT * FROM assets WHERE symbol=$1 AND venue=$2 LIMIT 1', [symbol, venue]);
    return r.rows[0] ? this.fromDb(r.rows[0]) : null;
  }
  async findByType(type: Asset['type']) {
    return (await this.q('SELECT * FROM assets WHERE asset_type=$1', [type])).rows.map((r) => this.fromDb(r));
  }
  async findBySector(sector: string) {
    return (await this.q('SELECT * FROM assets WHERE sector=$1', [sector])).rows.map((r) => this.fromDb(r));
  }
  async search(query: string) {
    return (
      await this.q('SELECT * FROM assets WHERE symbol ILIKE $1 OR name ILIKE $1 LIMIT 50', [`%${query}%`])
    ).rows.map((r) => this.fromDb(r));
  }
}

// ---------------------------------------------------------------------------
// Raw snapshots
// ---------------------------------------------------------------------------

class PgRawSnapshots implements RawSnapshotsRepository {
  constructor(private q: Q) {}

  private fromDb(r: pg.QueryResultRow): RawSnapshotRow {
    return {
      id: r.metadata?.app?.id ?? r.id,
      source: r.source,
      source_record_id: r.source_record_id,
      asset_uid: r.asset_uid,
      event_time: r.event_time,
      observed_time: r.observed_time,
      ingested_time: r.ingested_time,
      payload: r.payload,
      payload_hash: r.payload_hash,
      quality: r.quality,
      evidence_ref_ids: r.evidence_ref_ids ?? [],
      metadata: r.metadata ?? {},
    };
  }
  async insert(row: RawSnapshotRow) {
    if (row.asset_uid) await ensureAsset(this.q, row.asset_uid);
    await this.q(
      `INSERT INTO raw_snapshots (source, source_record_id, asset_uid, event_time, observed_time,
         ingested_time, payload, payload_hash, quality, evidence_ref_ids, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (source, source_record_id, payload_hash) DO NOTHING`,
      [
        row.source, row.source_record_id, row.asset_uid, row.event_time, row.observed_time,
        row.ingested_time, JSON.stringify(row.payload), row.payload_hash, row.quality,
        row.evidence_ref_ids, JSON.stringify({ ...row.metadata, app: { id: row.id } }),
      ],
    );
    return row;
  }
  async update(row: RawSnapshotRow) {
    return row; // raw snapshots are immutable retention
  }
  async findById(id: string) {
    const r = await this.q(`SELECT * FROM raw_snapshots WHERE metadata->'app'->>'id' = $1 OR id::text = $1`, [id]);
    return r.rows[0] ? this.fromDb(r.rows[0]) : null;
  }
  async findAll() {
    return (await this.q('SELECT * FROM raw_snapshots ORDER BY observed_time')).rows.map((r) => this.fromDb(r));
  }
  async delete(id: string) {
    return ((await this.q(`DELETE FROM raw_snapshots WHERE metadata->'app'->>'id' = $1`, [id])).rowCount ?? 0) > 0;
  }
  async exists(id: string) {
    return (await this.findById(id)) !== null;
  }
  async findBySource(source: string, limit = 100, offset = 0) {
    return (
      await this.q('SELECT * FROM raw_snapshots WHERE source=$1 ORDER BY observed_time LIMIT $2 OFFSET $3', [source, limit, offset])
    ).rows.map((r) => this.fromDb(r));
  }
  async findByAsset(assetUid: string, limit = 100) {
    return (
      await this.q('SELECT * FROM raw_snapshots WHERE asset_uid=$1 ORDER BY observed_time DESC LIMIT $2', [assetUid, limit])
    ).rows.map((r) => this.fromDb(r));
  }
  async findByTimeRange(start: Date, end: Date) {
    return (
      await this.q('SELECT * FROM raw_snapshots WHERE observed_time BETWEEN $1 AND $2', [start, end])
    ).rows.map((r) => this.fromDb(r));
  }
  async findByQuality(quality: RawSnapshotRow['quality']) {
    return (await this.q('SELECT * FROM raw_snapshots WHERE quality=$1', [quality])).rows.map((r) => this.fromDb(r));
  }
  async countBySource(source: string) {
    return Number((await this.q('SELECT COUNT(*) AS n FROM raw_snapshots WHERE source=$1', [source])).rows[0].n);
  }
  async deleteOlderThan(cutoff: Date) {
    return (await this.q('DELETE FROM raw_snapshots WHERE observed_time < $1', [cutoff])).rowCount ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

class PgObservations implements ObservationsRepository {
  constructor(private q: Q) {}

  private fromDb(r: pg.QueryResultRow): ObservationRow {
    const app = r.metadata?.app ?? {};
    return {
      id: app.id ?? r.id,
      asset_uid: r.asset_uid,
      symbol: r.symbol,
      venue: r.venue,
      price: reqNum(r.price),
      bid: num(r.bid),
      ask: num(r.ask),
      mark_price: num(r.mark_price),
      index_price: num(r.index_price),
      funding_rate: num(r.funding_rate),
      funding_rate_annualized: num(r.funding_rate_annualized),
      open_interest: num(r.open_interest),
      open_interest_usd: num(r.open_interest_usd),
      volume_24h: num(r.volume_24h),
      volume_24h_usd: num(r.volume_24h_usd),
      basis: num(r.basis),
      basis_annualized: num(r.basis_annualized),
      event_time: r.event_time,
      observed_time: r.observed_time,
      ingested_time: r.ingested_time,
      source: r.source,
      source_record_id: r.source_record_id,
      quality: r.quality,
      evidence_ref_ids: app.evidence_ref_ids ?? [],
    };
  }
  private async write(row: ObservationRow): Promise<void> {
    await ensureAsset(this.q, row.asset_uid, row.symbol, row.venue);
    await this.q(
      `INSERT INTO observations (asset_uid, symbol, venue, price, bid, ask, funding_rate,
         funding_rate_annualized, open_interest, open_interest_usd, volume_24h, volume_24h_usd,
         mark_price, index_price, basis, basis_annualized, event_time, observed_time,
         ingested_time, source, source_record_id, quality, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (asset_uid, venue, event_time, source) DO UPDATE SET
         price=EXCLUDED.price, funding_rate=EXCLUDED.funding_rate,
         funding_rate_annualized=EXCLUDED.funding_rate_annualized,
         open_interest=EXCLUDED.open_interest, open_interest_usd=EXCLUDED.open_interest_usd,
         observed_time=EXCLUDED.observed_time, quality=EXCLUDED.quality, metadata=EXCLUDED.metadata`,
      [
        row.asset_uid, row.symbol, row.venue, row.price, row.bid, row.ask, row.funding_rate,
        row.funding_rate_annualized, row.open_interest, row.open_interest_usd, row.volume_24h,
        row.volume_24h_usd, row.mark_price, row.index_price, row.basis, row.basis_annualized,
        row.event_time, row.observed_time, row.ingested_time, row.source, row.source_record_id,
        row.quality, JSON.stringify({ app: { id: row.id, evidence_ref_ids: row.evidence_ref_ids } }),
      ],
    );
  }
  async insert(row: ObservationRow) {
    await this.write(row);
    return row;
  }
  async update(row: ObservationRow) {
    await this.write(row);
    return row;
  }
  async findById(id: string) {
    const r = await this.q(`SELECT * FROM observations WHERE metadata->'app'->>'id' = $1`, [id]);
    return r.rows[0] ? this.fromDb(r.rows[0]) : null;
  }
  async findAll() {
    return (await this.q('SELECT * FROM observations ORDER BY event_time')).rows.map((r) => this.fromDb(r));
  }
  async delete(id: string) {
    return ((await this.q(`DELETE FROM observations WHERE metadata->'app'->>'id' = $1`, [id])).rowCount ?? 0) > 0;
  }
  async exists(id: string) {
    return (await this.findById(id)) !== null;
  }
  async findByAsset(assetUid: string, limit = 100) {
    return (
      await this.q('SELECT * FROM observations WHERE asset_uid=$1 ORDER BY event_time DESC LIMIT $2', [assetUid, limit])
    ).rows.map((r) => this.fromDb(r)).reverse();
  }
  async findByAssetAndTimeRange(assetUid: string, start: Date, end: Date) {
    return (
      await this.q(
        'SELECT * FROM observations WHERE asset_uid=$1 AND event_time BETWEEN $2 AND $3 ORDER BY event_time',
        [assetUid, start, end],
      )
    ).rows.map((r) => this.fromDb(r));
  }
  async findLatestByAsset(assetUid: string) {
    const r = await this.q('SELECT * FROM observations WHERE asset_uid=$1 ORDER BY observed_time DESC LIMIT 1', [assetUid]);
    return r.rows[0] ? this.fromDb(r.rows[0]) : null;
  }
  async findByVenueAndInterval(venue: string, _interval: string, limit = 100) {
    return (
      await this.q('SELECT * FROM observations WHERE venue=$1 ORDER BY event_time DESC LIMIT $2', [venue, limit])
    ).rows.map((r) => this.fromDb(r)).reverse();
  }
  async bulkInsert(observations: ObservationRow[]) {
    for (const o of observations) await this.write(o);
    return observations.length;
  }
  async getPriceSeries(assetUid: string, venue: string, _interval: string, start: Date, end: Date) {
    return (
      await this.q(
        'SELECT * FROM observations WHERE asset_uid=$1 AND venue=$2 AND event_time BETWEEN $3 AND $4 ORDER BY event_time',
        [assetUid, venue, start, end],
      )
    ).rows.map((r) => this.fromDb(r));
  }
}

// ---------------------------------------------------------------------------
// JSONB-mapped generic store for the remaining app rows.
// Natural key = app id; full row lives in metadata->'app'; a few indexed
// columns are projected for query performance.
// ---------------------------------------------------------------------------

interface JsonTableSpec<T extends { id: string }> {
  table: string;
  /** projected columns: name -> value extractor */
  columns: Record<string, (row: T) => unknown>;
  ensureAssetUid?: (row: T) => string | null;
}

class PgJsonStore<T extends { id: string }> {
  constructor(
    private q: Q,
    private spec: JsonTableSpec<T>,
    private revive: (app: Record<string, unknown>) => T,
  ) {}

  protected fromDb(r: pg.QueryResultRow): T {
    return this.revive(r.app as Record<string, unknown>);
  }
  async writeRow(row: T, upsert: boolean): Promise<void> {
    const uid = this.spec.ensureAssetUid?.(row);
    if (uid) await ensureAsset(this.q, uid);
    const cols = Object.keys(this.spec.columns);
    const vals = cols.map((c) => this.spec.columns[c](row));
    const placeholders = cols.map((_, i) => `$${i + 3}`);
    const sets = cols.map((c, i) => `${c}=$${i + 3}`).join(', ');
    await this.q(
      `INSERT INTO ${this.spec.table} (app_id, app${cols.length ? ', ' + cols.join(', ') : ''})
       VALUES ($1, $2${placeholders.length ? ', ' + placeholders.join(', ') : ''})
       ON CONFLICT (app_id) DO ${upsert ? `UPDATE SET app=$2${sets ? ', ' + sets : ''}` : 'NOTHING'}`,
      [row.id, JSON.stringify(row), ...vals],
    );
  }
  async selectWhere(where: string, params: unknown[], orderLimit = ''): Promise<T[]> {
    const r = await this.q(
      `SELECT app FROM ${this.spec.table}${where ? ' WHERE ' + where : ''} ${orderLimit}`,
      params,
    );
    return r.rows.map((row) => this.fromDb(row));
  }
  // BaseRepository surface
  async findById(id: string): Promise<T | null> {
    const rows = await this.selectWhere('app_id = $1', [id]);
    return rows[0] ?? null;
  }
  async findAll(): Promise<T[]> {
    return this.selectWhere('', [], 'ORDER BY app_id');
  }
  async insert(row: T): Promise<T> {
    await this.writeRow(row, false);
    return row;
  }
  async update(row: T): Promise<T> {
    await this.writeRow(row, true);
    return row;
  }
  async delete(id: string): Promise<boolean> {
    return ((await this.q(`DELETE FROM ${this.spec.table} WHERE app_id=$1`, [id])).rowCount ?? 0) > 0;
  }
  async exists(id: string): Promise<boolean> {
    return ((await this.q(`SELECT 1 FROM ${this.spec.table} WHERE app_id=$1`, [id])).rowCount ?? 0) > 0;
  }
}

/** Create the side tables the JSON stores use (idempotent, migration 015 inline). */
export const JSON_STORE_DDL = `
CREATE TABLE IF NOT EXISTS app_positioning_events (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL,
  asset_uid TEXT, event_type TEXT, actor_id TEXT, filer_name TEXT, wallet_address TEXT,
  event_time TIMESTAMPTZ, observed_time TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ape_asset ON app_positioning_events(asset_uid, event_time);
CREATE INDEX IF NOT EXISTS idx_ape_type ON app_positioning_events(event_type);
CREATE TABLE IF NOT EXISTS app_catalysts (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL,
  asset_uid TEXT, catalyst_type TEXT, status TEXT, scheduled_time TIMESTAMPTZ, observed_time TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS app_social_claims (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL,
  author_handle TEXT, platform TEXT, content_hash TEXT, event_time TIMESTAMPTZ, observed_time TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS app_evidence_refs (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL,
  kind TEXT, source TEXT, event_time TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS app_source_health (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL, source_id TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS app_jobs (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL, status TEXT, type TEXT
);
CREATE TABLE IF NOT EXISTS app_signals (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL,
  signal_id TEXT, asset_uid TEXT, family_id TEXT, cohort_version TEXT,
  abstained BOOLEAN, detected_time TIMESTAMPTZ, priority NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_asig_grading ON app_signals(abstained, detected_time);
CREATE TABLE IF NOT EXISTS app_abstentions (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL,
  signal_id TEXT, asset_uid TEXT, family_id TEXT, cohort_version TEXT, reason TEXT
);
CREATE TABLE IF NOT EXISTS app_grades (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL,
  signal_id TEXT, cohort_version TEXT, outcome TEXT, graded_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS app_outbox (
  app_id TEXT PRIMARY KEY, app JSONB NOT NULL,
  event_id TEXT, aggregate_type TEXT, aggregate_id TEXT, published BOOLEAN
);
`;

// date revival helper: JSONB round-trips Dates as ISO strings
function reviveDates<T>(app: Record<string, unknown>, dateKeys: string[]): T {
  const out: Record<string, unknown> = { ...app };
  for (const k of dateKeys) {
    if (typeof out[k] === 'string') out[k] = new Date(out[k] as string);
  }
  return out as T;
}

const POS_DATES = ['filing_date', 'transaction_date', 'expiration_date', 'event_time', 'observed_time', 'ingested_time'];
const CAT_DATES = ['scheduled_time', 'actual_time', 'settle_time', 'event_time', 'observed_time', 'ingested_time'];
const SOC_DATES = ['event_time', 'observed_time', 'ingested_time'];
const EVI_DATES = ['event_time', 'observed_time', 'ingested_time'];
const SH_DATES = ['last_checked', 'last_success', 'last_failure', 'rate_limit_reset'];
const JOB_DATES = ['scheduled_at', 'started_at', 'completed_at', 'next_retry_at', 'created_at', 'updated_at', 'locked_at'];
const SIG_DATES = ['event_time', 'observed_time', 'detected_time', 'created_at'];
const ABS_DATES = ['event_time', 'observed_time', 'detected_time', 'created_at'];
const GRD_DATES = ['graded_at', 'horizon_end', 'created_at'];
const OUT_DATES = ['created_at', 'published_at', 'next_retry_at'];

// ---------------------------------------------------------------------------

class PgPositioning extends PgJsonStore<PositioningEventRow> implements PositioningEventsRepository {
  constructor(q: Q) {
    super(
      q,
      {
        table: 'app_positioning_events',
        columns: {
          asset_uid: (r) => r.asset_uid,
          event_type: (r) => r.event_type,
          actor_id: (r) => r.wallet_address ?? r.filer_cik,
          filer_name: (r) => r.filer_name,
          wallet_address: (r) => r.wallet_address,
          event_time: (r) => r.event_time,
          observed_time: (r) => r.observed_time,
        },
        ensureAssetUid: (r) => r.asset_uid,
      },
      (app) => reviveDates<PositioningEventRow>(app, POS_DATES),
    );
  }
  findByAsset(assetUid: string, limit = 100) {
    return this.selectWhere('asset_uid=$1', [assetUid], `ORDER BY event_time DESC LIMIT ${limit}`);
  }
  findByWallet(walletAddress: string) {
    return this.selectWhere('wallet_address=$1', [walletAddress]);
  }
  findByFiler(filerName: string) {
    return this.selectWhere('filer_name=$1', [filerName]);
  }
  findByType(eventType: PositioningEventRow['event_type']) {
    return this.selectWhere('event_type=$1', [eventType]);
  }
  findByTimeRange(start: Date, end: Date) {
    return this.selectWhere('event_time BETWEEN $1 AND $2', [start, end]);
  }
  findByObservedRange(start: Date, end: Date) {
    return this.selectWhere('observed_time > $1 AND observed_time <= $2', [start, end]);
  }
  getWhalePositions(assetUid: string) {
    return this.selectWhere("event_type='whale_position' AND asset_uid=$1", [assetUid]);
  }
  getLeaderboardAggregates() {
    return this.selectWhere("event_type='leaderboard_aggregate'", []);
  }
  getInsiderFilings(assetUid?: string) {
    return assetUid
      ? this.selectWhere("event_type='insider_form4' AND asset_uid=$1", [assetUid])
      : this.selectWhere("event_type='insider_form4'", []);
  }
  getCongressionalDisclosures(assetUid?: string) {
    return assetUid
      ? this.selectWhere("event_type='congressional_disclosure' AND asset_uid=$1", [assetUid])
      : this.selectWhere("event_type='congressional_disclosure'", []);
  }
}

class PgCatalysts extends PgJsonStore<CatalystRow> implements CatalystsRepository {
  constructor(q: Q) {
    super(
      q,
      {
        table: 'app_catalysts',
        columns: {
          asset_uid: (r) => r.asset_uid,
          catalyst_type: (r) => r.catalyst_type,
          status: (r) => r.status,
          scheduled_time: (r) => r.scheduled_time,
          observed_time: (r) => r.observed_time,
        },
        ensureAssetUid: (r) => r.asset_uid,
      },
      (app) => reviveDates<CatalystRow>(app, CAT_DATES),
    );
  }
  findByAsset(assetUid: string, limit = 100) {
    return this.selectWhere('asset_uid=$1', [assetUid], `LIMIT ${limit}`);
  }
  findByType(t: CatalystRow['catalyst_type']) {
    return this.selectWhere('catalyst_type=$1', [t]);
  }
  findUpcoming(limit = 100) {
    return this.selectWhere('scheduled_time > NOW()', [], `ORDER BY scheduled_time LIMIT ${limit}`);
  }
  findByTimeRange(start: Date, end: Date) {
    return this.selectWhere('scheduled_time BETWEEN $1 AND $2', [start, end]);
  }
  findByStatus(status: CatalystRow['status']) {
    return this.selectWhere('status=$1', [status]);
  }
  async getSurprises(since: Date) {
    return (await this.selectWhere('observed_time >= $1', [since])).filter((c) => c.surprise_pct !== null);
  }
  async upsert(c: CatalystRow) {
    await this.writeRow(c, true);
    return c;
  }
}

class PgSocialClaims extends PgJsonStore<SocialClaimRow> implements SocialClaimsRepository {
  constructor(q: Q) {
    super(
      q,
      {
        table: 'app_social_claims',
        columns: {
          author_handle: (r) => r.author_handle,
          platform: (r) => r.platform,
          content_hash: (r) => r.content_hash,
          event_time: (r) => r.event_time,
          observed_time: (r) => r.observed_time,
        },
      },
      (app) => reviveDates<SocialClaimRow>(app, SOC_DATES),
    );
  }
  async findByAsset(assetUid: string, limit = 100) {
    return (await this.findAll()).filter((s) => s.asset_uids.includes(assetUid)).slice(0, limit);
  }
  findByAuthor(authorHandle: string) {
    return this.selectWhere('author_handle=$1', [authorHandle]);
  }
  findByPlatform(platform: SocialClaimRow['platform']) {
    return this.selectWhere('platform=$1', [platform]);
  }
  findByTimeRange(start: Date, end: Date) {
    return this.selectWhere('event_time BETWEEN $1 AND $2', [start, end]);
  }
  async findMentionsSpike(assetUid: string, windowMinutes: number) {
    const cutoff = new Date(Date.now() - windowMinutes * 60_000);
    return (await this.selectWhere('event_time >= $1', [cutoff])).filter((s) =>
      s.asset_uids.includes(assetUid),
    );
  }
  async findByContentHash(contentHash: string) {
    return (await this.selectWhere('content_hash=$1', [contentHash]))[0] ?? null;
  }
  async getTopEngagement(limit: number) {
    return (await this.findAll()).slice(0, limit);
  }
}

class PgEvidenceRefs extends PgJsonStore<EvidenceRefRow> implements EvidenceRefsRepository {
  constructor(q: Q) {
    super(
      q,
      {
        table: 'app_evidence_refs',
        columns: { kind: (r) => r.kind, source: (r) => r.source, event_time: (r) => r.event_time },
      },
      (app) => reviveDates<EvidenceRefRow>(app, EVI_DATES),
    );
  }
  async findByAsset(assetUid: string) {
    return (await this.findAll()).filter((e) => e.asset_uids.includes(assetUid));
  }
  findByKind(kind: EvidenceRefRow['kind']) {
    return this.selectWhere('kind=$1', [kind]);
  }
  findBySource(source: string) {
    return this.selectWhere('source=$1', [source]);
  }
  async findByIds(ids: string[]) {
    if (!ids.length) return [];
    return this.selectWhere(`app_id = ANY($1)`, [ids]);
  }
  findByTimeRange(start: Date, end: Date) {
    return this.selectWhere('event_time BETWEEN $1 AND $2', [start, end]);
  }
}

class PgSourceHealth extends PgJsonStore<SourceHealthRow> implements SourceHealthRepository {
  constructor(q: Q) {
    super(
      q,
      { table: 'app_source_health', columns: { source_id: (r) => r.source_id, status: (r) => r.status } },
      (app) => {
        const row = reviveDates<SourceHealthRow>(app, SH_DATES);
        row.errors = (row.errors ?? []).map((e) => ({ ...e, timestamp: new Date(e.timestamp) }));
        return row;
      },
    );
  }
  findByStatus(status: SourceHealthRow['status']) {
    return this.selectWhere('status=$1', [status]);
  }
  private blank(sourceId: string): SourceHealthRow {
    return {
      id: `health:${sourceId}`, source_id: sourceId, source_name: sourceId, status: 'healthy',
      last_checked: new Date(0), last_success: null, last_failure: null, consecutive_failures: 0,
      total_requests: 0, successful_requests: 0, failed_requests: 0, avg_latency_ms: null,
      p95_latency_ms: null, rate_limit_remaining: null, rate_limit_reset: null, errors: [],
      config: {}, sla: {}, metadata: {},
    };
  }
  async updateHealth(sourceId: string, updates: Partial<SourceHealthRow>) {
    const existing = (await this.selectWhere('source_id=$1', [sourceId]))[0] ?? this.blank(sourceId);
    const merged = { ...existing, ...updates, id: existing.id, source_id: sourceId };
    await this.writeRow(merged, true);
    return merged;
  }
  async recordError(sourceId: string, error: { type: string; message: string; timestamp: Date; metadata?: Record<string, unknown> }) {
    const h = await this.updateHealth(sourceId, {});
    h.consecutive_failures += 1;
    h.failed_requests += 1;
    h.total_requests += 1;
    h.last_failure = error.timestamp;
    h.last_checked = error.timestamp;
    h.errors = [...h.errors, error].slice(-20);
    h.status = h.consecutive_failures >= 3 ? 'unhealthy' : 'degraded';
    await this.writeRow(h, true);
  }
  async recordSuccess(sourceId: string, latencyMs: number) {
    const h = await this.updateHealth(sourceId, {});
    h.consecutive_failures = 0;
    h.successful_requests += 1;
    h.total_requests += 1;
    h.last_success = new Date();
    h.last_checked = h.last_success;
    h.avg_latency_ms = h.avg_latency_ms === null ? latencyMs : Math.round(0.8 * h.avg_latency_ms + 0.2 * latencyMs);
    h.status = 'healthy';
    await this.writeRow(h, true);
  }
}

class PgJobs extends PgJsonStore<JobRow> implements JobsRepository {
  constructor(q: Q) {
    super(
      q,
      { table: 'app_jobs', columns: { status: (r) => r.status, type: (r) => r.type } },
      (app) => reviveDates<JobRow>(app, JOB_DATES),
    );
  }
  findByStatus(status: JobRow['status']) {
    return this.selectWhere('status=$1', [status]);
  }
  async findPending(limit = 100) {
    return (await this.findByStatus('pending')).slice(0, limit);
  }
  findByType(type: string) {
    return this.selectWhere('type=$1', [type]);
  }
  async findRetryable() {
    const now = Date.now();
    return (await this.findByStatus('retrying')).filter((j) => (j.next_retry_at?.getTime() ?? 0) <= now);
  }
  async claimJob(jobId: string, lockToken: string) {
    const j = await this.findById(jobId);
    if (!j || j.lock_token !== null) return null;
    const claimed = { ...j, status: 'running' as const, lock_token: lockToken, locked_at: new Date(), started_at: new Date() };
    await this.writeRow(claimed, true);
    return claimed;
  }
  async releaseJob(jobId: string, lockToken: string) {
    const j = await this.findById(jobId);
    if (!j || j.lock_token !== lockToken) return false;
    await this.writeRow({ ...j, lock_token: null, locked_at: null }, true);
    return true;
  }
  async completeJob(jobId: string, result: Record<string, unknown>) {
    const j = await this.findById(jobId);
    if (!j) throw new Error(`missing job ${jobId}`);
    const done = { ...j, status: 'completed' as const, result, completed_at: new Date(), lock_token: null };
    await this.writeRow(done, true);
    return done;
  }
  async failJob(jobId: string, error: string, nextRetryAt?: Date) {
    const j = await this.findById(jobId);
    if (!j) throw new Error(`missing job ${jobId}`);
    const attempts = j.attempts + 1;
    const failed: JobRow = {
      ...j, attempts,
      status: nextRetryAt && attempts < j.max_attempts ? 'retrying' : 'failed',
      error: { message: error }, next_retry_at: nextRetryAt ?? null, lock_token: null,
    };
    await this.writeRow(failed, true);
    return failed;
  }
  async cleanupOlderThan(cutoff: Date) {
    const done = await this.findByStatus('completed');
    let n = 0;
    for (const j of done) {
      if ((j.completed_at?.getTime() ?? 0) < cutoff.getTime() && (await this.delete(j.id))) n++;
    }
    return n;
  }
}

class PgSignals extends PgJsonStore<SignalRow> implements SignalsRepository {
  constructor(q: Q) {
    super(
      q,
      {
        table: 'app_signals',
        columns: {
          signal_id: (r) => r.signal_id,
          asset_uid: (r) => r.asset_uid,
          family_id: (r) => r.family_id,
          cohort_version: (r) => r.cohort_version,
          abstained: (r) => r.abstained,
          detected_time: (r) => r.detected_time,
          priority: (r) => r.priority_score,
        },
        ensureAssetUid: (r) => r.asset_uid,
      },
      (app) => reviveDates<SignalRow>(app, SIG_DATES),
    );
  }
  findByAsset(assetUid: string, limit = 100) {
    return this.selectWhere('asset_uid=$1', [assetUid], `ORDER BY detected_time DESC LIMIT ${limit}`);
  }
  findByFamily(familyId: string) {
    return this.selectWhere('family_id=$1', [familyId]);
  }
  findByCohort(cohortVersion: string) {
    return this.selectWhere('cohort_version=$1', [cohortVersion]);
  }
  findActive(limit = 100) {
    return this.selectWhere('abstained=false', [], `ORDER BY detected_time DESC LIMIT ${limit}`);
  }
  findAbstained(limit = 100) {
    return this.selectWhere('abstained=true', [], `ORDER BY detected_time DESC LIMIT ${limit}`);
  }
  findByTimeRange(start: Date, end: Date) {
    return this.selectWhere('detected_time BETWEEN $1 AND $2', [start, end]);
  }
  async findByDedupeKey(dedupeKey: string) {
    return (await this.selectWhere('signal_id=$1', [dedupeKey]))[0] ?? null;
  }
  findForGradingSince(since: Date) {
    return this.selectWhere('abstained=false AND detected_time >= $1', [since]);
  }
  getForGrading(since: Date) {
    return this.findForGradingSince(since);
  }
  getPrioritySignals(limit: number) {
    return this.selectWhere('abstained=false', [], `ORDER BY priority DESC NULLS LAST LIMIT ${limit}`);
  }
  async upsert(signal: SignalRow) {
    await this.writeRow(signal, true);
    return signal;
  }
}

class PgAbstentions extends PgJsonStore<AbstentionRow> implements AbstentionsRepository {
  constructor(q: Q) {
    super(
      q,
      {
        table: 'app_abstentions',
        columns: {
          signal_id: (r) => r.signal_id,
          asset_uid: (r) => r.asset_uid,
          family_id: (r) => r.family_id,
          cohort_version: (r) => r.cohort_version,
          reason: (r) => r.reason,
        },
        ensureAssetUid: (r) => r.asset_uid,
      },
      (app) => reviveDates<AbstentionRow>(app, ABS_DATES),
    );
  }
  async findBySignalId(signalId: string) {
    return (await this.selectWhere('signal_id=$1', [signalId]))[0] ?? null;
  }
  findByAsset(assetUid: string) {
    return this.selectWhere('asset_uid=$1', [assetUid]);
  }
  findByReason(reason: string) {
    return this.selectWhere('reason=$1', [reason]);
  }
  findByCohort(cohortVersion: string) {
    return this.selectWhere('cohort_version=$1', [cohortVersion]);
  }
  findByFamily(familyId: string) {
    return this.selectWhere('family_id=$1', [familyId]);
  }
  async countByReason() {
    const out: Record<string, number> = {};
    for (const a of await this.findAll()) out[a.reason] = (out[a.reason] ?? 0) + 1;
    return out;
  }
}

class PgGrades extends PgJsonStore<GradeRow> implements GradesRepository {
  constructor(q: Q) {
    super(
      q,
      {
        table: 'app_grades',
        columns: {
          signal_id: (r) => r.signal_id,
          cohort_version: (r) => r.cohort_version,
          outcome: (r) => r.outcome,
          graded_at: (r) => r.graded_at,
        },
      },
      (app) => reviveDates<GradeRow>(app, GRD_DATES),
    );
  }
  async findBySignalId(signalId: string) {
    return (await this.selectWhere('signal_id=$1', [signalId]))[0] ?? null;
  }
  findByCohort(cohortVersion: string) {
    return this.selectWhere('cohort_version=$1', [cohortVersion]);
  }
  findByOutcome(outcome: GradeRow['outcome']) {
    return this.selectWhere('outcome=$1', [outcome]);
  }
  findByTimeRange(start: Date, end: Date) {
    return this.selectWhere('graded_at BETWEEN $1 AND $2', [start, end]);
  }
  async getStats(cohortVersion: string): Promise<GradeStats> {
    return this.stats(await this.findByCohort(cohortVersion));
  }
  async getFamilyStats(cohortVersion: string, _familyId: string): Promise<GradeStats> {
    return this.getStats(cohortVersion);
  }
  private stats(grades: GradeRow[]): GradeStats {
    const byOutcome: Record<string, number> = {};
    let wins = 0;
    let decisive = 0;
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    for (const g of grades) {
      byOutcome[g.outcome] = (byOutcome[g.outcome] ?? 0) + 1;
      if (['TARGET_HIT', 'INVALIDATED', 'TIMEOUT_WIN', 'TIMEOUT_LOSS'].includes(g.outcome)) {
        decisive++;
        if (g.outcome === 'TARGET_HIT' || g.outcome === 'TIMEOUT_WIN') wins++;
      }
    }
    return {
      total: grades.length,
      byOutcome,
      avgMfeR: mean(grades.map((g) => g.mfe_r ?? 0)),
      avgMaeR: mean(grades.map((g) => g.mae_r ?? 0)),
      avgRealizedR: mean(grades.map((g) => g.realized_r ?? 0)),
      winRate: decisive ? wins / decisive : 0,
      hitRate: decisive ? wins / decisive : 0,
    };
  }
}

class PgOutbox extends PgJsonStore<OutboxRow> implements OutboxRepository {
  constructor(q: Q) {
    super(
      q,
      {
        table: 'app_outbox',
        columns: {
          event_id: (r) => r.event_id,
          aggregate_type: (r) => r.aggregate_type,
          aggregate_id: (r) => r.aggregate_id,
          published: (r) => r.published,
        },
      },
      (app) => reviveDates<OutboxRow>(app, OUT_DATES),
    );
  }
  findUnpublished(limit = 100) {
    return this.selectWhere('published=false', [], `LIMIT ${limit}`);
  }
  findByAggregate(aggregateType: string, aggregateId: string) {
    return this.selectWhere('aggregate_type=$1 AND aggregate_id=$2', [aggregateType, aggregateId]);
  }
  async markPublished(eventId: string) {
    const o = (await this.selectWhere('event_id=$1', [eventId]))[0];
    if (!o) throw new Error(`missing outbox event ${eventId}`);
    const done = { ...o, published: true, published_at: new Date() };
    await this.writeRow(done, true);
    return done;
  }
  async markFailed(eventId: string, error: string, nextRetryAt: Date) {
    const o = (await this.selectWhere('event_id=$1', [eventId]))[0];
    if (!o) throw new Error(`missing outbox event ${eventId}`);
    const failed = { ...o, attempts: o.attempts + 1, last_error: error, next_retry_at: nextRetryAt };
    await this.writeRow(failed, true);
    return failed;
  }
  async cleanupPublishedOlderThan(cutoff: Date) {
    const done = await this.selectWhere('published=true', []);
    let n = 0;
    for (const o of done) {
      if ((o.published_at?.getTime() ?? 0) < cutoff.getTime() && (await this.delete(o.id))) n++;
    }
    return n;
  }
}

class PgCandles implements CandlesRepository {
  constructor(private q: Q) {}
  private fromDb(r: pg.QueryResultRow): CandleRow {
    return {
      id: r.id, asset_uid: r.asset_uid, symbol: r.symbol, venue: r.venue,
      bar_interval: r.bar_interval, open_time: r.open_time,
      open: reqNum(r.open), high: reqNum(r.high), low: reqNum(r.low), close: reqNum(r.close),
      volume: num(r.volume), source: r.source, quality: r.quality, ingested_time: r.ingested_time,
    };
  }
  private async write(c: CandleRow): Promise<void> {
    await this.q(
      `INSERT INTO candles (id, asset_uid, symbol, venue, bar_interval, open_time, open, high, low, close, volume, source, quality, ingested_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (asset_uid, venue, bar_interval, open_time) DO UPDATE SET
         open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close,
         volume=EXCLUDED.volume, quality=EXCLUDED.quality`,
      [c.id, c.asset_uid, c.symbol, c.venue, c.bar_interval, c.open_time, c.open, c.high, c.low, c.close, c.volume, c.source, c.quality, c.ingested_time],
    );
  }
  async insert(c: CandleRow) {
    await this.write(c);
    return c;
  }
  async update(c: CandleRow) {
    await this.write(c);
    return c;
  }
  async findById(id: string) {
    const r = await this.q('SELECT * FROM candles WHERE id=$1', [id]);
    return r.rows[0] ? this.fromDb(r.rows[0]) : null;
  }
  async findAll() {
    return (await this.q('SELECT * FROM candles ORDER BY open_time')).rows.map((r) => this.fromDb(r));
  }
  async delete(id: string) {
    return ((await this.q('DELETE FROM candles WHERE id=$1', [id])).rowCount ?? 0) > 0;
  }
  async exists(id: string) {
    return ((await this.q('SELECT 1 FROM candles WHERE id=$1', [id])).rowCount ?? 0) > 0;
  }
  async upsertMany(candles: CandleRow[]) {
    for (const c of candles) await this.write(c);
    return candles.length;
  }
  async getSeries(assetUid: string, venue: string, interval: string, start: Date, end: Date) {
    return (
      await this.q(
        'SELECT * FROM candles WHERE asset_uid=$1 AND venue=$2 AND bar_interval=$3 AND open_time BETWEEN $4 AND $5 ORDER BY open_time',
        [assetUid, venue, interval, start, end],
      )
    ).rows.map((r) => this.fromDb(r));
  }
  async latestOpenTime(assetUid: string, venue: string, interval: string) {
    const r = await this.q(
      'SELECT MAX(open_time) AS t FROM candles WHERE asset_uid=$1 AND venue=$2 AND bar_interval=$3',
      [assetUid, venue, interval],
    );
    return r.rows[0]?.t ?? null;
  }
}

// ---------------------------------------------------------------------------

export interface PgFactoryOptions {
  connectionString: string;
  max?: number;
}

export async function createPgRepositoryFactory(
  options: PgFactoryOptions,
): Promise<RepositoryFactory & { pool: pg.Pool }> {
  const pool = new Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  const q: Q = (text, params) => pool.query(text, params as never);

  // app-side tables (idempotent) — core tables come from migrations 001–014
  await pool.query(JSON_STORE_DDL);

  const factory: RepositoryFactory & { pool: pg.Pool } = {
    pool,
    assets: new PgAssets(q),
    rawSnapshots: new PgRawSnapshots(q),
    observations: new PgObservations(q),
    positioningEvents: new PgPositioning(q),
    catalysts: new PgCatalysts(q),
    socialClaims: new PgSocialClaims(q),
    evidenceRefs: new PgEvidenceRefs(q),
    sourceHealth: new PgSourceHealth(q),
    jobs: new PgJobs(q),
    signals: new PgSignals(q),
    abstentions: new PgAbstentions(q),
    grades: new PgGrades(q),
    outbox: new PgOutbox(q),
    candles: new PgCandles(q),
    async transaction<T>(fn: (f: RepositoryFactory) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cq: Q = (text, params) => client.query(text, params as never);
        const txFactory: RepositoryFactory = {
          assets: new PgAssets(cq),
          rawSnapshots: new PgRawSnapshots(cq),
          observations: new PgObservations(cq),
          positioningEvents: new PgPositioning(cq),
          catalysts: new PgCatalysts(cq),
          socialClaims: new PgSocialClaims(cq),
          evidenceRefs: new PgEvidenceRefs(cq),
          sourceHealth: new PgSourceHealth(cq),
          jobs: new PgJobs(cq),
          signals: new PgSignals(cq),
          abstentions: new PgAbstentions(cq),
          grades: new PgGrades(cq),
          outbox: new PgOutbox(cq),
          candles: new PgCandles(cq),
          transaction: () => {
            throw new Error('nested transactions not supported');
          },
          close: async () => undefined,
        };
        const result = await fn(txFactory);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
  return factory;
}
