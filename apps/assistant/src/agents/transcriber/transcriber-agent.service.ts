import { Inject, Injectable } from '@nestjs/common';

import type { IAgent } from '../../orchestrator/agent.registry.js';

import type { ITranscriberClient } from './transcriber.client.js';
import {
  STT_ALLOWED_MIME,
  type SttMimeType,
  type TranscribeResult,
} from './transcriber.schemas.js';

export const TRANSCRIBER_CLIENT = Symbol.for('TRANSCRIBER_CLIENT');

export interface TranscribePayload {
  audio: Buffer;
  mimeType: SttMimeType | string;
  filename?: string;
  language?: string;
  prompt?: string;
  requestId?: string;
}

export type TranscriberAgentResult = TranscribeResult;

@Injectable()
export class TranscriberAgentService implements IAgent {
  readonly name = 'transcriber';
  readonly intents = ['/transcribe'] as const;

  constructor(@Inject(TRANSCRIBER_CLIENT) private readonly client: ITranscriberClient) {}

  async execute(intent: string, payload?: unknown): Promise<TranscriberAgentResult> {
    if (intent !== '/transcribe') {
      throw new Error(`TranscriberAgent does not handle intent "${intent}"`);
    }
    if (this.client.isCircuitOpen()) {
      return { kind: 'unavailable', reason: 'transcriber_circuit_open' };
    }
    const input = payload as TranscribePayload | undefined;
    if (!input || !Buffer.isBuffer(input.audio) || input.audio.byteLength === 0) {
      return { kind: 'unavailable', reason: 'transcriber_empty_audio' };
    }
    if (!isAllowedMime(input.mimeType)) {
      return {
        kind: 'unavailable',
        reason: 'transcriber_unsupported_mime',
        detail: `mimeType "${input.mimeType}" not supported`,
      };
    }
    try {
      return await this.client.transcribe({
        audio: input.audio,
        mimeType: input.mimeType,
        filename: input.filename ?? defaultFilename(input.mimeType),
        ...(input.language ? { language: input.language } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: 'transcriber_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function isAllowedMime(mime: string): mime is SttMimeType {
  return (STT_ALLOWED_MIME as readonly string[]).includes(mime);
}

function defaultFilename(mime: string): string {
  switch (mime) {
    case 'audio/ogg':
      return 'voice.ogg';
    case 'audio/webm':
      return 'voice.webm';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'voice.wav';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'voice.m4a';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'voice.flac';
    case 'audio/mpeg':
    case 'audio/mp3':
    default:
      return 'voice.mp3';
  }
}
