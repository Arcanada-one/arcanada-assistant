import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import type { ActiveTask, ArchivedItem, BacklogItem, CompletedTask } from './proactive.types.js';

const TASK_LINE = /^-\s+([A-Z]+-\d{4,})\s+·\s+(\S+)\s+·\s+P(\d)\s+·\s+L(\d)\s+·\s+(.+?)\s+→/;

export interface KbFreshnessResult {
  stale: boolean;
  lastSyncIso: string;
  ageHours: number;
}

export interface IDatarimReader {
  readActiveTasks(): Promise<ActiveTask[]>;
  readBacklogTopN(n: number, priorities?: readonly string[]): Promise<BacklogItem[]>;
  readCompletedToday(runDate: string): Promise<CompletedTask[]>;
  readArchivedToday(runDate: string): Promise<ArchivedItem[]>;
  sourceAvailable(): Promise<boolean>;
  kbFreshness(thresholdHours?: number): Promise<KbFreshnessResult>;
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

  constructor() {
    this.root = resolve(process.env.DATARIM_PATH ?? '/data/datarim');
  }

  static withRoot(rootPath: string): DatarimReaderService {
    const instance = new DatarimReaderService();
    (instance as unknown as { root: string }).root = resolve(rootPath);
    return instance;
  }

  /**
   * ARCA-0154: true when the datarim root directory is mounted and readable.
   * Lets aggregators distinguish a broken source (DATARIM_PATH unmounted →
   * every section ENOENT) from an honestly-empty one (mounted, no entries
   * today). A missing root → degraded marker; a present root with empty files
   * → honest «нет/пусто».
   */
  async sourceAvailable(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.root);
      return stat.isDirectory();
    } catch (err) {
      this.logger.warn(`datarim source unavailable at ${this.root}: ${(err as Error).message}`);
      return false;
    }
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

  /**
   * ARCA-0162: Returns tasks archived today with human-readable titles.
   * The previous implementation read the "Последние завершённые" section from
   * activeContext.md, which was removed by the thin-one-liner schema migration
   * (dr-doctor), causing this method to always return [].
   *
   * New approach: scan the same archive directory as readArchivedToday, filter
   * by today's mtime, then read each file's title from YAML frontmatter
   * (`title:` field) or the first markdown heading (`# ...`) as fallback.
   * Archives with `status: cancelled` in frontmatter are excluded.
   */
  async readCompletedToday(runDate: string): Promise<CompletedTask[]> {
    const archiveRoot = join(this.root, '..', 'documentation', 'archive');
    const out: CompletedTask[] = [];
    try {
      const subdirs = await fs.readdir(archiveRoot, { withFileTypes: true });
      for (const sub of subdirs) {
        if (!sub.isDirectory()) continue;
        const subPath = join(archiveRoot, sub.name);
        const files = await fs.readdir(subPath);
        for (const f of files) {
          const m = /^archive-([A-Z]+-\d{4,})\.md$/.exec(f);
          if (!m) continue;
          const filePath = join(subPath, f);
          const stat = await fs.stat(filePath);
          if (this.toRunDate(stat.mtime) !== runDate) continue;
          const parsed = await this.parseArchiveTitle(m[1]!, filePath);
          if (parsed) out.push(parsed);
        }
      }
    } catch (err) {
      this.logger.warn(`completed-today scan failed: ${(err as Error).message}`);
    }
    return out;
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

  /**
   * ARCA-0163: Reports whether the KB files are fresh enough to trust.
   * Checks mtime of the three key operational files (tasks.md, activeContext.md,
   * backlog.md). Uses max(mtime) so that a single recently-synced file is
   * sufficient to mark the KB as fresh. If none of the key files exist,
   * ageHours is Infinity (stale).
   *
   * Default threshold: 3 hours (3× the hourly rsync push interval).
   * Override via `thresholdHours` arg or `KB_STALENESS_THRESHOLD_HOURS` env.
   */
  async kbFreshness(
    thresholdHours: number = Number(process.env.KB_STALENESS_THRESHOLD_HOURS ?? 3),
  ): Promise<KbFreshnessResult> {
    const keyFiles = ['tasks.md', 'activeContext.md', 'backlog.md'];
    let newestMtime: Date | null = null;
    for (const name of keyFiles) {
      try {
        const stat = await fs.stat(join(this.root, name));
        if (newestMtime === null || stat.mtime > newestMtime) {
          newestMtime = stat.mtime;
        }
      } catch {
        // file absent — skip, keep looking at others
      }
    }
    if (newestMtime === null) {
      return { stale: true, lastSyncIso: new Date(0).toISOString(), ageHours: Infinity };
    }
    const ageMs = Date.now() - newestMtime.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    return {
      stale: ageHours > thresholdHours,
      lastSyncIso: newestMtime.toISOString(),
      ageHours,
    };
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

  /**
   * Reads an archive-{ID}.md file and returns { id, title } or null if the
   * archive is cancelled (excluded from "Завершено сегодня"). Title is sourced
   * from YAML frontmatter `title:` field when present, falling back to the
   * first markdown heading `# ...`.
   */
  private async parseArchiveTitle(id: string, filePath: string): Promise<CompletedTask | null> {
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      this.logger.warn(`parseArchiveTitle read failed for ${id}: ${(err as Error).message}`);
      return null;
    }

    // Check for YAML frontmatter (--- ... ---)
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (fmMatch) {
      const fm = fmMatch[1]!;
      // Exclude cancelled archives
      if (/^status:\s*cancelled\s*$/m.test(fm)) return null;
      // Extract title from frontmatter
      const titleMatch = /^title:\s*(.+?)\s*$/m.exec(fm);
      if (titleMatch) {
        return { id, title: titleMatch[1]!.trim() };
      }
    }

    // Fallback: first markdown heading
    const headingMatch = /^#\s+(.+)/m.exec(text);
    if (headingMatch) {
      return { id, title: headingMatch[1]!.trim() };
    }

    // No title found — still return the ID-only entry rather than dropping it
    return { id, title: id };
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
