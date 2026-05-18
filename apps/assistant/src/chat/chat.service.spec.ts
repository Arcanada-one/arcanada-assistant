import { describe, expect, it, vi } from 'vitest';

import { DialogContextService } from '../orchestrator/dialog.context.js';

import { ClaudeService } from './chat.service.js';

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

function makeServices(scrutator: ReturnType<typeof makeScrutatorStub>) {
  const dialogContext = new DialogContextService(
    scrutator as unknown as Parameters<typeof DialogContextService>[0] extends never
      ? never
      : Parameters<typeof DialogContextService>[0],
    'assistant-test',
  );
  const claude = new ClaudeService(dialogContext);
  return { dialogContext, claude };
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
});
