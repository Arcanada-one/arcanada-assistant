import { describe, expect, it } from 'vitest';

import {
  MuneraApiKeyUnauthorizedEnvelopeSchema,
  MuneraGlobalErrorEnvelopeSchema,
  MuneraJwtUnauthorizedEnvelopeSchema,
} from './munera.schemas.js';

/**
 * Live-fixture replay: verifies Zod schemas parse the exact payloads captured
 * from PROD Munera on 2026-05-17 via `ssh root@100.121.155.54`. Source
 * artefact: `datarim/tasks/ARCA-0009-fixtures.md` § "Munera — POST /api/v1/tasks".
 *
 * Drift detection: if Munera changes error envelope shape (rename `error`,
 * drop `statusCode`, embed in nested structure), this test fails and the
 * operator MUST recapture before shipping a client change.
 *
 * NOTE: success-path (201 task create) fixture is currently schema-derived
 * from compiled DTO at `/app/apps/api/dist/tasks/dto/create-task.dto.js` —
 * Munera PROD DB is empty (zero users), so JWT mint is impossible until
 * V-AC-21 operator smoke phase. Schema replay tests reflect only the
 * envelopes we could capture live (401 ×2 shapes, 404).
 */
describe('Munera live-fixture replay', () => {
  it('parses JwtAuthGuard 401 envelope (no error field — bare UnauthorizedException)', () => {
    const fixture = { statusCode: 401, message: 'Unauthorized' } as const;
    expect(MuneraJwtUnauthorizedEnvelopeSchema.parse(fixture)).toEqual(fixture);
  });

  it('parses ApiKeyGuard 401 envelope (with error field — UnauthorizedException("API key required"))', () => {
    const fixture = {
      statusCode: 401,
      error: 'Unauthorized' as const,
      message: 'API key required',
    };
    expect(MuneraApiKeyUnauthorizedEnvelopeSchema.parse(fixture)).toEqual(fixture);
  });

  it('parses 404 NotFoundException envelope from global filter', () => {
    const fixture = {
      statusCode: 404,
      error: 'Not Found',
      message: 'Cannot GET /api/v1/nonexistent',
    };
    expect(MuneraGlobalErrorEnvelopeSchema.parse(fixture)).toEqual(fixture);
  });

  it('parses 400 class-validator envelope (message-as-array)', () => {
    const fixture = {
      statusCode: 400,
      error: 'Bad Request',
      message: ['title must be longer than or equal to 1 characters', 'projectId must be a UUID'],
    };
    expect(MuneraGlobalErrorEnvelopeSchema.parse(fixture)).toEqual(fixture);
  });
});
