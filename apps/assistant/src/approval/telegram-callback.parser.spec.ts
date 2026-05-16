import { describe, expect, it } from 'vitest';

import {
  CallbackParseError,
  encodeApprovalCallback,
  parseApprovalCallback,
} from './telegram-callback.parser.js';

const VALID_UUID = '01941d7e-3b22-7c11-9f56-d4e3a8b9c012';

describe('telegram-callback parser', () => {
  it('encodes + parses approve round-trip', () => {
    const encoded = encodeApprovalCallback(VALID_UUID, 'approve');
    expect(encoded).toBe(`apr:v1:a:${VALID_UUID}`);
    const parsed = parseApprovalCallback(encoded);
    expect(parsed).toEqual({ raw: encoded, uuid: VALID_UUID, decision: 'approve' });
  });

  it('encodes + parses reject round-trip', () => {
    const encoded = encodeApprovalCallback(VALID_UUID, 'reject');
    expect(encoded).toBe(`apr:v1:r:${VALID_UUID}`);
    const parsed = parseApprovalCallback(encoded);
    expect(parsed.decision).toBe('reject');
    expect(parsed.uuid).toBe(VALID_UUID);
  });

  it('stays ≤ 64 bytes for any valid UUID', () => {
    const encoded = encodeApprovalCallback(VALID_UUID, 'approve');
    expect(encoded.length).toBeLessThanOrEqual(64);
  });

  it('rejects missing prefix', () => {
    expect(() => parseApprovalCallback(`bad:v1:a:${VALID_UUID}`)).toThrow(CallbackParseError);
  });

  it('rejects unknown decision tag', () => {
    expect(() => parseApprovalCallback(`apr:v1:x:${VALID_UUID}`)).toThrow(/decision/);
  });

  it('rejects malformed UUID', () => {
    expect(() => parseApprovalCallback('apr:v1:a:not-a-uuid')).toThrow(CallbackParseError);
  });

  it('rejects too-long callback_data', () => {
    const tooLong = `apr:v1:a:${VALID_UUID}-` + 'x'.repeat(60);
    expect(() => parseApprovalCallback(tooLong)).toThrow(/exceeds/);
  });
});
