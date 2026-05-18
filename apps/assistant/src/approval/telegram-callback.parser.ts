/**
 * `apr:v1:<decision>:<uuid-v7>` envelope decoder. Hard 64-byte cap per Telegram
 * callback_data limit. `decision` is the single-letter tag `a` (approve) or
 * `r` (reject), kept tiny to leave room for the UUID. Format adopted in
 * creative-ARCA-0009-architecture-telegram-callback-hmac.md after the HMAC
 * path was rejected in favour of UUIDv7 + Redis envelope.
 *
 * Wire example:  `apr:v1:a:01941d7e-3b22-7c11-9f56-d4e3a8b9c012`  (47 bytes)
 */

const PREFIX = 'apr:v1:';
const MAX_LEN = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ApprovalDecisionTag = 'a' | 'r';
export type ApprovalDecisionVerb = 'approve' | 'reject';

export class CallbackParseError extends Error {
  readonly reason: 'too_long' | 'bad_prefix' | 'bad_uuid' | 'bad_decision';
  constructor(reason: CallbackParseError['reason'], message: string) {
    super(message);
    this.name = 'CallbackParseError';
    this.reason = reason;
  }
}

export interface ApprovalCallback {
  raw: string;
  uuid: string;
  decision: ApprovalDecisionVerb;
}

const TAG_BY_VERB: Record<ApprovalDecisionVerb, ApprovalDecisionTag> = {
  approve: 'a',
  reject: 'r',
};

const VERB_BY_TAG: Record<ApprovalDecisionTag, ApprovalDecisionVerb> = {
  a: 'approve',
  r: 'reject',
};

export function parseApprovalCallback(callbackData: string): ApprovalCallback {
  if (callbackData.length > MAX_LEN) {
    throw new CallbackParseError('too_long', `callback_data exceeds ${MAX_LEN} bytes`);
  }
  if (!callbackData.startsWith(PREFIX)) {
    throw new CallbackParseError('bad_prefix', `expected prefix "${PREFIX}"`);
  }
  const remainder = callbackData.slice(PREFIX.length);
  const colon = remainder.indexOf(':');
  if (colon !== 1) {
    throw new CallbackParseError(
      'bad_decision',
      'expected single-letter decision tag followed by ":"',
    );
  }
  const tag = remainder.charAt(0);
  if (tag !== 'a' && tag !== 'r') {
    throw new CallbackParseError('bad_decision', `unknown decision tag "${tag}"`);
  }
  const uuid = remainder.slice(2);
  if (!UUID_RE.test(uuid)) {
    throw new CallbackParseError(
      'bad_uuid',
      'callback_data uuid does not match RFC 9562 UUID v1-v8 layout',
    );
  }
  return { raw: callbackData, uuid, decision: VERB_BY_TAG[tag] };
}

export function encodeApprovalCallback(uuid: string, decision: ApprovalDecisionVerb): string {
  if (!UUID_RE.test(uuid)) {
    throw new CallbackParseError('bad_uuid', 'uuid must match RFC 9562 UUID v1-v8 layout');
  }
  const out = `${PREFIX}${TAG_BY_VERB[decision]}:${uuid}`;
  if (out.length > MAX_LEN) {
    throw new CallbackParseError('too_long', `encoded callback exceeds ${MAX_LEN} bytes`);
  }
  return out;
}
