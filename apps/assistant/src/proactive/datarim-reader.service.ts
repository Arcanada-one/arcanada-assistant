import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import type { ActiveTask, ArchivedItem, BacklogItem, CompletedTask } from './proactive.types.js';

const TASK_LINE = /^-\s+([A-Z]+-\d{4,})\s+·\s+(\S+)\s+·\s+P(\d)\s+·\s+L(\d)\s+·\s+(.+?)\s+→/;

export interface IDatarimReader {
  readActiveTasks(): Promise<ActiveTask[]>;
  readBacklogTopN(n: number, priorities?: readonly string[]): Promise<BacklogItem[]>;
  readCompletedToday(runDate: string): Promise<CompletedTask[]>;
  readArchivedToday(runDate: string): Promise<ArchivedItem[]>;
}

/**
 * Reads operational Datarim files mounted into the container at
 * `DATARIM_PATH` (default `/data/datarim`). On laptop dev, point this at
 * `~/arcanada/datarim`. Files are markdown one-liners per
 * `skills/datarim-system.md` § Operational File Schema. Failures are
 * fail-soft: empty list returned with `pino.warn` so a missing mount does
 * not block the proactive cycle — operator sees a degraded briefing.
 */
@Injectable()
export class DatarimReaderService implements IDatarimReader {
  private readonly logger = new Logger(DatarimReaderService.name);
  private readonly root: string;

  constructor(rootPath?: string) {
    this.root = resolve(rootPath ?? process.env.DATARIM_PATH ?? '/data/datarim');
  }

  async readActiveTasks(): Promise<ActiveTask[]> {
    const lines = await this.readLines('tasks.md');
    const out: ActiveTask[] = [];
    for (const line of lines) {
      const parsed = this.parseTaskLine(line);
      if (parsed && parsed.status === 'in_progress') {
        out.push(parsed);
      }
    }
    return out;
  }

  async readBacklogTopN(
    n: number,
    priorities: readonly string[] = ['P0', 'P1'],
  ): Promise<BacklogItem[]> {
    if (n <= 0) return [];
    const lines = await this.readLines('backlog.md');
    const out: BacklogItem[] = [];
    for (const line of lines) {
      const parsed = this.parseTaskLine(line);
      if (!parsed) continue;
      if (parsed.status !== 'pending') continue;
      if (!priorities.includes(parsed.priority)) continue;
      out.push({
        id: parsed.id,
        title: parsed.title,
        priority: parsed.priority,
        complexity: parsed.complexity,
      });
      if (out.length >= n) break;
    }
    return out;
  }

  async readCompletedToday(runDate: string): Promise<CompletedTask[]> {
    const lines = await this.readLines('activeContext.md');
    return lines
      .map((l) => this.parseCompletedLine(l, runDate))
      .filter((x): x is CompletedTask => x !== null);
  }

  async readArchivedToday(runDate: string): Promise<ArchivedItem[]> {
    const archiveRoot = join(this.root, '..', 'documentation', 'archive');
    const out: ArchivedItem[] = [];
    try {
      const subdirs = await fs.readdir(archiveRoot, { withFileTypes: true });
      for (const sub of subdirs) {
        if (!sub.isDirectory()) continue;
        const subPath = join(archiveRoot, sub.name);
        const files = await fs.readdir(subPath);
        for (const f of files) {
          const m = /^archive-([A-Z]+-\d{4,})\.md$/.exec(f);
          if (!m) continue;
          const stat = await fs.stat(join(subPath, f));
          if (this.toRunDate(stat.mtime) !== runDate) continue;
          out.push({ id: m[1]!, subdir: sub.name, mtime: stat.mtime });
        }
      }
    } catch (err) {
      this.logger.warn(`archive scan failed: ${(err as Error).message}`);
    }
    return out;
  }

  private parseTaskLine(line: string): ActiveTask | null {
    const m = TASK_LINE.exec(line.trim());
    if (!m) return null;
    return {
      id: m[1]!,
      status: m[2]!,
      priority: `P${m[3]!}`,
      complexity: `L${m[4]!}`,
      title: m[5]!.trim(),
    };
  }

  private parseCompletedLine(line: string, runDate: string): CompletedTask | null {
    const tagged = line.match(
      /-\s+\*\*([A-Z]+-\d{4,})\*\*[^—]*—\s+(.+?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?$/,
    );
    if (!tagged) return null;
    const date = tagged[3];
    if (date && date !== runDate) return null;
    return { id: tagged[1]!, title: tagged[2]!.trim() };
  }

  private async readLines(file: string): Promise<string[]> {
    try {
      const text = await fs.readFile(join(this.root, file), 'utf-8');
      return text.split('\n');
    } catch (err) {
      this.logger.warn(`read ${file} failed: ${(err as Error).message}`);
      return [];
    }
  }

  private toRunDate(d: Date): string {
    const iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    return iso;
  }
}
