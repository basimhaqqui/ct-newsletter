export type AssetUID = string;

export interface FactEnvelope<T> {
  schema_version: string;
  source: string;
  source_record_id: string;
  asset_uid?: AssetUID;
  event_time: string;
  observed_time: string;
  ingested_time: string;
  payload_hash: string;
  quality: 'ok' | 'degraded' | 'stale';
  evidence_ref_ids: string[];
  data: T;
}

export interface FactReference {
  id: string;
  type: string;
}

export interface SourceMetadata {
  id: string;
  name: string;
  url: string;
  reliability: number;
  lastUpdated: Date;
}

export interface SourceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastChecked: Date;
  errors: TypedSourceError[];
}

export interface TypedSourceError {
  type: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface SignalCandidate {
  id: string;
  confidence: number;
  source: FactReference;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface Abstention {
  reason: string;
  timestamp: Date;
  source: FactReference;
}

export interface Asset {
  id: string;
  symbol: string;
  name: string;
  type: 'crypto' | 'stock' | 'commodity' | 'fx';
  decimals?: number;
}

export interface Observation {
  id: string;
  asset: FactReference;
  price: number;
  timestamp: Date;
  source: FactReference;
}

export interface PositioningEvent {
  id: string;
  asset: FactReference;
  type: 'entry' | 'exit' | 'adjustment';
  size: number;
  price: number;
  timestamp: Date;
  source: FactReference;
}

export interface Catalyst {
  id: string;
  type: string;
  impact: 'high' | 'medium' | 'low';
  startTime: Date;
  endTime?: Date;
  assets: FactReference[];
  source: FactReference;
}

export interface SocialClaim {
  id: string;
  content: string;
  author: string;
  timestamp: Date;
  source: FactReference;
  evidence?: EvidenceRef[];
}

export interface EvidenceRef {
  type: 'link' | 'document' | 'media';
  url: string;
  description?: string;
}