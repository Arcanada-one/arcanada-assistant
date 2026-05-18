import { describe, expect, it, vi } from 'vitest';

import { ProactiveConfigService, type ProactiveConfigSource } from './proactive-config.service.js';

const VALID_YAML = `
enabled: true
timezone: Europe/Istanbul
channels:
  briefing:
    enabled: true
    cron: "0 8 * * *"
    chat_id: 1234567890
    include_active_tasks: true
    include_backlog_top_n: 3
    include_ecosystem_snapshot: true
    include_night_events_section: false
  digest:
    enabled: true
    cron: "0 21 * * *"
    chat_id: 1234567890
    include_completed_tasks: true
    include_archived_items: true
    include_key_events: false
dispatch:
  max_attempts: 3
  base_backoff_ms: 1000
  self_heal_threshold: 3
  fallback_to_plain_text_on_md_error: true
observability:
  pino_level: info
  prometheus_counter: assistant_proactive_dispatched_total
`;

class StubSource implements ProactiveConfigSource {
  constructor(public yaml: string) {}
  read(): Promise<string> {
    return Promise.resolve(this.yaml);
  }
}

describe('ProactiveConfigService', () => {
  it('loadOnce parses a valid YAML', async () => {
    const svc = ProactiveConfigService.withSource(new StubSource(VALID_YAML));
    const cfg = await svc.loadOnce();
    expect(cfg.enabled).toBe(true);
    expect(cfg.channels.briefing.cron).toBe('0 8 * * *');
  });

  it('throws with a useful message on Zod parse failure', async () => {
    const broken = VALID_YAML.replace('Europe/Istanbul', 'UTC');
    const svc = ProactiveConfigService.withSource(new StubSource(broken));
    await expect(svc.loadOnce()).rejects.toThrow(/parse failed/);
  });

  it('fires listeners on initial load', async () => {
    const svc = ProactiveConfigService.withSource(new StubSource(VALID_YAML), 0);
    const listener = vi.fn();
    svc.onChange(listener);
    await svc.start();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].enabled).toBe(true);
    expect(listener.mock.calls[0]![1]).toBeNull();
    svc.stop();
  });

  it('does not re-fire listeners when content is identical', async () => {
    const src = new StubSource(VALID_YAML);
    const svc = ProactiveConfigService.withSource(src, 0);
    const listener = vi.fn();
    svc.onChange(listener);
    await svc.start();
    await svc.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it('fires listeners on content change', async () => {
    const src = new StubSource(VALID_YAML);
    const svc = ProactiveConfigService.withSource(src, 0);
    const listener = vi.fn();
    svc.onChange(listener);
    await svc.start();
    src.yaml = VALID_YAML.replace('enabled: true', 'enabled: false');
    await svc.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]![0].enabled).toBe(false);
    expect(listener.mock.calls[1]![1]).not.toBeNull();
    svc.stop();
  });

  it('keeps last-good on transient parse failure (no listener fire)', async () => {
    const src = new StubSource(VALID_YAML);
    const svc = ProactiveConfigService.withSource(src, 0);
    const listener = vi.fn();
    svc.onChange(listener);
    await svc.start();
    src.yaml = 'not valid yaml :::';
    await svc.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(svc.snapshot()?.enabled).toBe(true);
    svc.stop();
  });
});
