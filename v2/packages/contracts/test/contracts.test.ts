import { describe, it, expect } from 'vitest';
import { validateFactEnvelope, type FactEnvelope } from '../src/index.js';

describe('contracts', () => {
  describe('validateFactEnvelope', () => {
    it('should validate a correct FactEnvelope', () => {
      const envelope: FactEnvelope<{ foo: string }> = {
        schema_version: '1.0',
        source: 'test-source',
        source_record_id: 'rec-123',
        asset_uid: 'asset-456',
        event_time: '2024-01-01T00:00:00Z',
        observed_time: '2024-01-01T00:00:01Z',
        ingested_time: '2024-01-01T00:00:02Z',
        payload_hash: 'abc123',
        quality: 'ok',
        evidence_ref_ids: ['ev-1', 'ev-2'],
        data: { foo: 'bar' }
      };

      expect(() => validateFactEnvelope(envelope)).not.toThrow();
    });

    it('should throw for invalid FactEnvelope', () => {
      expect(() => validateFactEnvelope(null)).toThrow('FactEnvelope must be an object');
      expect(() => validateFactEnvelope({})).toThrow('FactEnvelope.schema_version must be a string');
      expect(() => validateFactEnvelope({ schema_version: '1.0' })).toThrow('FactEnvelope.source must be a string');
    });
  });

  // Add tests for other types as needed
});