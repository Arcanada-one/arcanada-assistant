import { promises as fs } from 'node:fs';

import { Injectable, Logger } from '@nestjs/common';
import { load as yamlLoad } from 'js-yaml';

import { ProactiveConfigSchema, type ProactiveConfig } from './proactive.types.js';

const DEFAULT_POLL_MS = 5 * 60 * 1000;

export type ConfigChangeListener = (next: ProactiveConfig, prev: ProactiveConfig | null) => void;

export interface ProactiveConfigSource {
  read(): Promise<string>;
}

class FilesystemConfigSource implements ProactiveConfigSource {
  constructor(private readonly path: string) {}
  read(): Promise<string> {
    return fs.readFile(this.path, 'utf-8');
  }
}

/**
 * Loads the proactive-config YAML and polls for hot-reload.
 *
 * Plan called for a Vault HTTP client; deferred — no Vault SDK exists in this
 * repo yet. We read from `PROACTIVE_CONFIG_PATH` (operator wires this via
 * Vault Agent template OR manual `vault kv get | yq > file` cron). The
 * 5-minute poll re-reads + re-parses; on change, listeners fire so the
 * processor can re-register cron patterns. Drop-in replaceable with a
 * `VaultConfigSource` once a Vault client lands.
 */
@Injectable()
export class ProactiveConfigService {
  private readonly logger = new Logger(ProactiveConfigService.name);
  private readonly listeners = new Set<ConfigChangeListener>();
  private current: ProactiveConfig | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly source: ProactiveConfigSource,
    private readonly pollMs: number = DEFAULT_POLL_MS,
  ) {}

  static fromPath(path: string, pollMs?: number): ProactiveConfigService {
    return new ProactiveConfigService(new FilesystemConfigSource(path), pollMs);
  }

  static withSource(source: ProactiveConfigSource, pollMs?: number): ProactiveConfigService {
    return new ProactiveConfigService(source, pollMs);
  }

  async loadOnce(): Promise<ProactiveConfig> {
    const raw = await this.source.read();
    const parsedYaml = yamlLoad(raw);
    const result = ProactiveConfigSchema.safeParse(parsedYaml);
    if (!result.success) {
      const messages = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`proactive config parse failed: ${messages}`);
    }
    return result.data;
  }

  async start(): Promise<void> {
    const initial = await this.loadOnce();
    this.notify(initial);
    if (this.pollMs <= 0) return;
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        this.logger.error(`config refresh failed: ${(err as Error).message}`);
      });
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ProactiveConfig | null {
    return this.current;
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    try {
      const next = await this.loadOnce();
      if (this.current && this.isEqual(this.current, next)) return;
      this.notify(next);
    } catch (err) {
      this.logger.warn(`config reload failed (keeping last-good): ${(err as Error).message}`);
    }
  }

  private notify(next: ProactiveConfig): void {
    const prev = this.current;
    this.current = next;
    for (const listener of this.listeners) {
      try {
        listener(next, prev);
      } catch (err) {
        this.logger.warn(`config listener threw: ${(err as Error).message}`);
      }
    }
  }

  private isEqual(a: ProactiveConfig, b: ProactiveConfig): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
