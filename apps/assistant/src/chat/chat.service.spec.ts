import { describe, expect, it, vi } from 'vitest';

import type { IClaudeClient } from '../agents/claude/claude.client.js';
import type { ClaudeResult } from '../agents/claude/claude.schemas.js';
import type { ClaudeConfig } from '../config/claude.config.js';
import { DialogContextService } from '../orchestrator/dialog.context.js';

import {
  CLAUDE_UNAVAILABLE_REPLY,
  ClaudeService,
  PLACEHOLDER_REPLY,
} from './chat.service.js';

interface ScrutatorStubOptions {
  recallResult?: { results: { content: string; score: number }[] };
  circuitOpen?: boolean;
  throws?: Error;
}

function scrutatorRecall(hits: { content: string; score: number }[] = []) {
  return { results: hits };
}

function makeScrutatorStub(opts: ScrutatorStubOptions = {}) {
  return {
    recallLtm: vi.fn().mockImplementation(async () => {
      if (opts.throws) throw opts.throws;
      return opts.recallResult ?? scrutatorRecall([]);
    }),
    ingestLtm: vi.fn(),
    searchWiki: vi.fn(),
    ping: vi.fn(),
    isCircuitOpen: vi.fn().mockReturnValue(opts.circuitOpen ?? false),
  };
}

interface VisionStubs {
  visionEnabled?: boolean;
  claudeResult?: ClaudeResult;
  costWarnUsd?: number;
}

function makeServices(
  scrutator: ReturnType<typeof makeScrutatorStub>,
  stubs: VisionStubs = {},
) {
  const dialogContext = new DialogContextService(
    scrutator as unknown as Parameters<typeof DialogContextService>[0] extends never
      ? never
      : Parameters<typeof DialogContextService>[0],
    'assistant-test',
  );
  const claudeClient: IClaudeClient = {
    complete: vi.fn().mockResolvedValue(
      stubs.claudeResult ??
        ({
          kind: 'ok',
          reply: 'stubbed reply',
          model: 'anthropic/claude-sonnet-4',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          costUsd: 0.0001,
          latencyMs: 10,
          requestId: 'req-1',
        } satisfies ClaudeResult),
    ),
    isCircuitOpen: vi.fn().mockReturnValue(false),
  };
  const config: Pick<
    import('@nestjs/config').ConfigService,
    'get' | 'getOrThrow'
  > = {
    get: vi.fn().mockImplementation((token: string) => {
      if (token === 'claude') {
        return {
          baseUrl: 'http://mc',
          apiKey: 'k',
          defaultModel: 'anthropic/claude-sonnet-4',
          timeoutMs: 60_000,
          costWarnUsd: stubs.costWarnUsd ?? 0.1,
          visionEnabled: stubs.visionEnabled ?? false,
        } satisfies ClaudeConfig;
      }
      return undefined;
    }),
    getOrThrow: vi.fn(),
  } as unknown as import('@nestjs/config').ConfigService;
  const claude = new ClaudeService(
    dialogContext,
    config as unknown as import('@nestjs/config').ConfigService,
    claudeClient,
  );
  return { dialogContext, claude, claudeClient };
}

describe('ClaudeService — ARCA-0101 dialog-context wire-up', () => {
  it('handleTurn calls DialogContextService.buildSystemPrompt on every turn', async () => {
    const scrutator = makeScrutatorStub();
    const { dialogContext, claude } = makeServices(scrutator);
    const buildSpy = vi.spyOn(dialogContext, 'buildSystemPrompt');

    await claude.handleTurn(101, 'привет');
    await claude.handleTurn(101, 'как дела');
    await claude.handleTurn(202, 'другая сессия');

    expect(buildSpy).toHaveBeenCalledTimes(3);
    expect(buildSpy.mock.calls[0][0]).toBe(101);
    expect(buildSpy.mock.calls[0][1]).toBe('привет');
    expect(buildSpy.mock.calls[2][0]).toBe(202);
  });

  it('handleTurn injects LTM recall block into systemPrompt when Scrutator returns hits', async () => {
    const scrutator = makeScrutatorStub({
      recallResult: scrutatorRecall([
        { content: 'Pavel предпочитает русский язык', score: 0.85 },
        { content: 'Pavel ведёт Arcanada как solo founder', score: 0.72 },
      ]),
    });
    const { claude } = makeServices(scrutator);

    const turn = await claude.handleTurn(101, 'что ты помнишь обо мне?');

    expect(turn.ragApplied).toBe(true);
    expect(turn.systemPrompt).toMatch(/past_conversation_memories/);
    expect(turn.systemPrompt).toMatch(/Pavel предпочитает русский язык/);
    expect(scrutator.recallLtm).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'assistant-test:user:101',
        query: 'что ты помнишь обо мне?',
      }),
    );
  });

  it('handleTurn produces system-prompt-only result when LTM has zero hits', async () => {
    const scrutator = makeScrutatorStub({ recallResult: scrutatorRecall([]) });
    const { claude } = makeServices(scrutator);

    const turn = await claude.handleTurn(101, 'fresh user no memories');

    expect(turn.ragApplied).toBe(false);
    expect(turn.systemPrompt).not.toMatch(/past_conversation_memories/);
    expect(turn.systemPrompt.length).toBeGreaterThan(0);
  });

  it('handleTurn soft-fails when Scrutator circuit is open (no exception, ragApplied=true with placeholder)', async () => {
    const scrutator = makeScrutatorStub({ circuitOpen: true });
    const { claude } = makeServices(scrutator);

    const turn = await claude.handleTurn(101, 'привет');

    expect(turn.reply).toBeTruthy();
    expect(turn.systemPrompt).toMatch(/долговременной памяти временно недоступен/);
    expect(scrutator.recallLtm).not.toHaveBeenCalled();
  });

  it('handleTurn soft-fails when Scrutator throws (no exception leaks to caller)', async () => {
    const scrutator = makeScrutatorStub({ throws: new Error('boom') });
    const { claude } = makeServices(scrutator);

    const turn = await claude.handleTurn(101, 'hello');

    expect(turn.reply).toBeTruthy();
    expect(turn.systemPrompt).toMatch(/долговременной памяти временно недоступен/);
  });

  it('handleTurn skips dialog context when userMessage is empty (no Scrutator call)', async () => {
    const scrutator = makeScrutatorStub();
    const { claude } = makeServices(scrutator);

    const turn = await claude.handleTurn(101, '   ');

    expect(scrutator.recallLtm).not.toHaveBeenCalled();
    expect(turn.ragApplied).toBe(false);
    expect(turn.reply).toBe('');
  });

  it('handleTurn forwards maxHits / minScore options to DialogContextService', async () => {
    const scrutator = makeScrutatorStub();
    const { claude } = makeServices(scrutator);

    await claude.handleTurn(101, 'with options', { maxHits: 2, minScore: 0.3 });

    expect(scrutator.recallLtm).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, min_score: 0.3 }),
    );
  });

  // ARCA-0011 ---------------------------------------------------------------

  it('falls back to PLACEHOLDER_REPLY when CLAUDE_VISION_ENABLED=false', async () => {
    const scrutator = makeScrutatorStub();
    const { claude, claudeClient } = makeServices(scrutator, { visionEnabled: false });
    const turn = await claude.handleTurn(101, 'привет');
    expect(turn.reply).toBe(PLACEHOLDER_REPLY);
    expect(claudeClient.complete).not.toHaveBeenCalled();
  });

  it('routes to ClaudeClient and returns real reply when vision enabled', async () => {
    const scrutator = makeScrutatorStub();
    const { claude, claudeClient } = makeServices(scrutator, {
      visionEnabled: true,
      claudeResult: {
        kind: 'ok',
        reply: 'Привет! Чем могу помочь?',
        model: 'anthropic/claude-sonnet-4',
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        costUsd: 0.0004,
        latencyMs: 220,
        requestId: 'req-2',
      },
    });
    const turn = await claude.handleTurn(101, 'привет', { modality: 'text' });
    expect(turn.reply).toBe('Привет! Чем могу помочь?');
    expect(turn.meta?.model).toBe('anthropic/claude-sonnet-4');
    expect(turn.meta?.costUsd).toBeCloseTo(0.0004, 6);
    expect(claudeClient.complete).toHaveBeenCalledOnce();
    const arg = (claudeClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.content).toBe('привет');
    expect(arg.systemPrompt).toContain('Arcanada Assistant');
  });

  it('emits CLAUDE_UNAVAILABLE_REPLY on circuit-open / 5xx fail-soft', async () => {
    const scrutator = makeScrutatorStub();
    const { claude } = makeServices(scrutator, {
      visionEnabled: true,
      claudeResult: { kind: 'unavailable', reason: 'claude_circuit_open' },
    });
    const turn = await claude.handleTurn(101, 'hello', { modality: 'voice' });
    expect(turn.reply).toBe(CLAUDE_UNAVAILABLE_REPLY);
  });

  it('forwards ContentBlock[] prompt to ClaudeClient on photo modality', async () => {
    const scrutator = makeScrutatorStub();
    const { claude, claudeClient } = makeServices(scrutator, { visionEnabled: true });
    const blocks = [
      { type: 'text' as const, text: 'Опиши это фото' },
      {
        type: 'image_url' as const,
        image_url: { url: 'data:image/jpeg;base64,/9j/abc=' },
      },
    ];
    await claude.handleTurn(101, blocks, { modality: 'photo' });
    const arg = (claudeClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.content).toEqual(blocks);
  });

  it('extracts text from ContentBlock[] for LTM recall query', async () => {
    const scrutator = makeScrutatorStub();
    const { claude } = makeServices(scrutator, { visionEnabled: true });
    await claude.handleTurn(
      101,
      [
        { type: 'text', text: 'Что на фото?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,X' } },
      ],
      { modality: 'photo' },
    );
    expect(scrutator.recallLtm).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Что на фото?' }),
    );
  });

  it('buildSystemPrompt is called for each of voice/photo/document/text modalities', async () => {
    const scrutator = makeScrutatorStub();
    const { dialogContext, claude } = makeServices(scrutator, { visionEnabled: true });
    const spy = vi.spyOn(dialogContext, 'buildSystemPrompt');
    await claude.handleTurn(101, 'voice text', { modality: 'voice' });
    await claude.handleTurn(101, [{ type: 'text', text: 'doc text' }], {
      modality: 'document',
    });
    await claude.handleTurn(
      101,
      [
        { type: 'text', text: 'photo caption' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,X' } },
      ],
      { modality: 'photo' },
    );
    await claude.handleTurn(101, 'plain text', { modality: 'text' });
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
