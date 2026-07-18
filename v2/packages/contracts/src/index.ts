export * from './types.js';

import type { FactEnvelope } from './types.js';

export function validateFactEnvelope<T>(envelope: unknown): asserts envelope is FactEnvelope<T> {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error('FactEnvelope must be an object');
  }

  const e = envelope as Record<string, unknown>;

  if (typeof e.schema_version !== 'string') {
    throw new Error('FactEnvelope.schema_version must be a string');
  }

  if (typeof e.source !== 'string') {
    throw new Error('FactEnvelope.source must be a string');
  }

  if (typeof e.source_record_id !== 'string') {
    throw new Error('FactEnvelope.source_record_id must be a string');
  }

  if (e.asset_uid !== undefined && typeof e.asset_uid !== 'string') {
    throw new Error('FactEnvelope.asset_uid must be a string if present');
  }

  if (typeof e.event_time !== 'string') {
    throw new Error('FactEnvelope.event_time must be a string');
  }

  if (typeof e.observed_time !== 'string') {
    throw new Error('FactEnvelope.observed_time must be a string');
  }

  if (typeof e.ingested_time !== 'string') {
    throw new Error('FactEnvelope.ingested_time must be a string');
  }

  if (typeof e.payload_hash !== 'string') {
    throw new Error('FactEnvelope.payload_hash must be a string');
  }

  if (!['ok', 'degraded', 'stale'].includes(e.quality as string)) {
    throw new Error('FactEnvelope.quality must be ok, degraded, or stale');
  }

  if (!Array.isArray(e.evidence_ref_ids)) {
    throw new Error('FactEnvelope.evidence_ref_ids must be an array');
  }
}