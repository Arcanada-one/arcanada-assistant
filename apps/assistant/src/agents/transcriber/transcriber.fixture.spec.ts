import { describe, expect, it } from 'vitest';

import {
  SttErrorEnvelopeSchema,
  SttSuccessSchema,
  SttUnauthorizedEnvelopeSchema,
} from './transcriber.schemas.js';

/**
 * Live-fixture replay: verifies that the Zod schemas can parse the exact
 * payloads captured from PROD Model Connector `POST /v1/speech/stt`. Source
 * artefact: `datarim/tasks/ARCA-0009-fixtures.md`.
 *
 * Drift detection: if MC API changes (renamed field, dropped field, type
 * widening), this test fails and the operator MUST recapture the fixture
 * before shipping a client change.
 */
describe('Transcriber live-fixture replay', () => {
  it('parses 200 success envelope (1s 440Hz tone)', () => {
    const fixture = {
      transcription: 'Продолжение следует...',
      model: 'whisper-large-v3',
      provider: 'groq',
      language: 'ru',
      latency_ms: 283,
      cost_usd: 0.000031,
      audio_duration_seconds: 1,
      fallback_count: 0,
      request_id: '1886fac3-3c2b-4aca-8544-5248e02388ad',
    };
    expect(SttSuccessSchema.parse(fixture)).toEqual(fixture);
  });

  it('parses 400 stt_validation_error envelope (unsupported MIME)', () => {
    const fixture = {
      statusCode: 400,
      error_code: 'stt_validation_error',
      message:
        'mimeType: mimeType must be one of: audio/wav, audio/x-wav, audio/mpeg, audio/mp3, audio/mp4, audio/x-m4a, audio/webm, audio/ogg, audio/flac, audio/x-flac',
    };
    expect(SttErrorEnvelopeSchema.parse(fixture)).toEqual(fixture);
  });

  it('parses 401 unauthorized envelope (Bearer missing)', () => {
    const fixture = {
      statusCode: 401,
      error: 'Unauthorized' as const,
      message: 'Missing Bearer token',
    };
    expect(SttUnauthorizedEnvelopeSchema.parse(fixture)).toEqual(fixture);
  });

  it('parses 500 stt_provider_failed envelope (multipart parse failure)', () => {
    const fixture = {
      statusCode: 500,
      error_code: 'stt_provider_failed',
      message: 'Unexpected STT failure',
    };
    expect(SttErrorEnvelopeSchema.parse(fixture)).toEqual(fixture);
  });
});
