// Social-mention and catalyst-calendar pipelines (closes the last two fact
// streams the engine consumes). Ports are structural; the live Apify/X glue
// and any calendar source (earnings API, curated JSON, ICS) bolt on at deploy.

import type { CatalystRow, SocialClaimRow } from '@market-intel/db';
import { hashPayload } from './hash.js';
import type { IngestionContext, IngestionJob, IngestionResult } from './types.js';

// ---------------------------------------------------------------------------
// Social (v1 radar semantics: viral posts, cashtags, engagement floor)
// ---------------------------------------------------------------------------

export interface ViralPost {
  postId: string;
  authorHandle: string;
  authorFollowers: number | null;
  text: string;
  cashtags: string[]; // upper-cased symbols, stables pre-filtered
  likes: number;
  url: string | null;
  postedAtMs: number;
}

export interface SocialPort {
  /** viral posts within the scan window (min-faves filter applied upstream) */
  fetchViralPosts(): Promise<ViralPost[]>;
}

/** symbol → canonical asset_uid (or null to skip unknown tickers) */
export type AssetResolver = (symbol: string) => string | null;

export function socialClaimRow(
  post: ViralPost,
  assetUids: string[],
  observedAt: Date,
): SocialClaimRow {
  return {
    id: `x:post:${post.postId}`,
    claim_id: `x:post:${post.postId}`,
    asset_uids: assetUids,
    cashtags: post.cashtags,
    hashtags: [],
    author_id: post.authorHandle,
    author_handle: post.authorHandle,
    author_followers: post.authorFollowers,
    author_verified: false,
    content: post.text,
    content_hash: hashPayload(post.text),
    platform: 'x',
    post_type: 'post',
    engagement: { likes: post.likes },
    sentiment_score: null,
    sentiment_label: null,
    language: 'en',
    urls: post.url ? [post.url] : [],
    media_urls: [],
    parent_claim_id: null,
    conversation_id: null,
    source: 'apify_x',
    source_record_id: `x:post:${post.postId}`,
    event_time: new Date(post.postedAtMs),
    observed_time: observedAt,
    ingested_time: observedAt,
    quality: 'ok',
    evidence_ref_ids: [`apify_x:post:${post.postId}`],
    metadata: {},
  };
}

export function socialJob(
  port: SocialPort,
  resolveAsset: AssetResolver,
  intervalS = 1800,
): IngestionJob {
  return {
    name: 'social-viral-mentions',
    source: 'apify_x',
    intervalS,
    async run(ctx: IngestionContext): Promise<IngestionResult> {
      const started = Date.now();
      const result: IngestionResult = {
        source: 'apify_x',
        rawSnapshots: 0,
        observations: 0,
        positioningEvents: 0,
        errors: [],
      };
      try {
        const observedAt = ctx.clock();
        const posts = await port.fetchViralPosts();
        for (const post of posts) {
          const uids = [...new Set(post.cashtags.map(resolveAsset).filter((u): u is string => u !== null))];
          if (uids.length === 0) continue; // no covered asset → not a claim we track
          const row = socialClaimRow(post, uids, observedAt);
          if (await ctx.repos.socialClaims.exists(row.id)) continue; // idempotent
          await ctx.repos.socialClaims.insert(row);
          result.rawSnapshots += 1;
        }
        await ctx.repos.sourceHealth.recordSuccess('apify_x', Date.now() - started);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
        await ctx.repos.sourceHealth.recordError('apify_x', {
          type: 'INGESTION_FAILURE',
          message: err instanceof Error ? err.message : String(err),
          timestamp: ctx.clock(),
        });
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Catalysts (earnings / macro prints / unlocks — any calendar source)
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  eventId: string;
  assetUid: string;
  catalystType: CatalystRow['catalyst_type'];
  title: string;
  impact: 'high' | 'medium' | 'low';
  scheduledAtMs: number;
  actualAtMs: number | null;
  consensusEstimate: Record<string, unknown> | null;
  actualValue: Record<string, unknown> | null;
  surprisePct: number | null;
  source: string;
  url: string | null;
}

export interface CatalystPort {
  fetchEvents(): Promise<CalendarEvent[]>;
}

export function catalystRow(e: CalendarEvent, observedAt: Date): CatalystRow {
  const completed = e.actualAtMs !== null;
  return {
    id: `${e.source}:catalyst:${e.eventId}`,
    catalyst_id: e.eventId,
    catalyst_type: e.catalystType,
    asset_uid: e.assetUid,
    title: e.title,
    description: null,
    impact: e.impact,
    status: completed ? 'completed' : 'scheduled',
    scheduled_time: new Date(e.scheduledAtMs),
    actual_time: e.actualAtMs ? new Date(e.actualAtMs) : null,
    settle_time: null,
    consensus_estimate: e.consensusEstimate,
    actual_value: e.actualValue,
    surprise_pct: e.surprisePct,
    source: e.source,
    source_record_id: e.eventId,
    event_time: e.actualAtMs ? new Date(e.actualAtMs) : new Date(Math.min(e.scheduledAtMs, observedAt.getTime())),
    observed_time: observedAt,
    ingested_time: observedAt,
    quality: 'ok',
    evidence_ref_ids: [`${e.source}:${e.eventId}`],
    metadata: {},
  };
}

export function catalystJob(port: CatalystPort, intervalS = 3600): IngestionJob {
  return {
    name: 'catalyst-calendar',
    source: 'catalyst_calendar',
    intervalS,
    async run(ctx: IngestionContext): Promise<IngestionResult> {
      const started = Date.now();
      const result: IngestionResult = {
        source: 'catalyst_calendar',
        rawSnapshots: 0,
        observations: 0,
        positioningEvents: 0,
        errors: [],
      };
      try {
        const observedAt = ctx.clock();
        for (const e of await port.fetchEvents()) {
          await ctx.repos.catalysts.upsert(catalystRow(e, observedAt));
          result.rawSnapshots += 1;
        }
        await ctx.repos.sourceHealth.recordSuccess('catalyst_calendar', Date.now() - started);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
        await ctx.repos.sourceHealth.recordError('catalyst_calendar', {
          type: 'INGESTION_FAILURE',
          message: err instanceof Error ? err.message : String(err),
          timestamp: ctx.clock(),
        });
      }
      return result;
    },
  };
}
