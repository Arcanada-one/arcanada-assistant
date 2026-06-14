import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatarimReaderService } from './datarim-reader.service.js';

async function writeFile(root: string, name: string, body: string): Promise<void> {
  await fs.writeFile(join(root, name), body, 'utf-8');
}

describe('DatarimReaderService', () => {
  let root: string;
  let archiveRoot: string;
  let svc: DatarimReaderService;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'arca-0010-'));
    root = join(base, 'datarim');
    archiveRoot = join(base, 'documentation', 'archive');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(archiveRoot, { recursive: true });
    svc = DatarimReaderService.withRoot(root);
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  describe('readActiveTasks', () => {
    it('parses one-liner format and filters by in_progress', async () => {
      await writeFile(
        root,
        'tasks.md',
        [
          '- ARCA-0010 · in_progress · P2 · L2 · Proactive Communication — daily briefing → tasks/ARCA-0010-task-description.md',
          '- AUTH-0079 · pending · P1 · L3 · Mesh JWT integration → tasks/AUTH-0079-task-description.md',
          '- TRANS-0061 · in_progress · P0 · L1 · Hot-bug replay → tasks/TRANS-0061-task-description.md',
        ].join('\n'),
      );
      const tasks = await svc.readActiveTasks();
      expect(tasks.map((t) => t.id)).toEqual(['ARCA-0010', 'TRANS-0061']);
      expect(tasks[0]!.priority).toBe('P2');
      expect(tasks[0]!.complexity).toBe('L2');
      expect(tasks[1]!.title).toBe('Hot-bug replay');
    });

    it('returns empty list when tasks.md missing (fail-soft)', async () => {
      const tasks = await svc.readActiveTasks();
      expect(tasks).toEqual([]);
    });

    it('skips garbage lines without throwing', async () => {
      await writeFile(
        root,
        'tasks.md',
        ['# Header line', '', 'not a task at all', '- malformed ID → wrong'].join('\n'),
      );
      const tasks = await svc.readActiveTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe('readBacklogTopN', () => {
    beforeEach(async () => {
      await writeFile(
        root,
        'backlog.md',
        [
          '- INFRA-0235 · pending · P0 · L2 · Top blocker A → tasks/INFRA-0235-task-description.md',
          '- AUTH-0079 · pending · P1 · L3 · Top blocker B → tasks/AUTH-0079-task-description.md',
          '- ARCA-0123 · pending · P1 · L2 · Top blocker C → tasks/ARCA-0123-task-description.md',
          '- TRANS-0099 · pending · P2 · L2 · Lower priority → tasks/TRANS-0099-task-description.md',
          '- DONE-0001 · done · P0 · L1 · Already done → tasks/DONE-0001-task-description.md',
        ].join('\n'),
      );
    });

    it('returns top 3 P0/P1 pending only', async () => {
      const top = await svc.readBacklogTopN(3);
      expect(top.map((b) => b.id)).toEqual(['INFRA-0235', 'AUTH-0079', 'ARCA-0123']);
    });

    it('returns empty when n=0', async () => {
      const top = await svc.readBacklogTopN(0);
      expect(top).toEqual([]);
    });

    it('honours custom priorities filter', async () => {
      const top = await svc.readBacklogTopN(3, ['P2']);
      expect(top.map((b) => b.id)).toEqual(['TRANS-0099']);
    });
  });

  describe('readArchivedToday', () => {
    it('finds archive-{ID}.md files with today mtime', async () => {
      const transcribatorDir = join(archiveRoot, 'transcribator');
      await fs.mkdir(transcribatorDir, { recursive: true });
      const filePath = join(transcribatorDir, 'archive-TRANS-0011.md');
      await fs.writeFile(filePath, '# archive', 'utf-8');
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const items = await svc.readArchivedToday(today);
      expect(items.map((i) => i.id)).toContain('TRANS-0011');
      expect(items[0]!.subdir).toBe('transcribator');
    });

    it('returns empty list when archive directory missing (fail-soft)', async () => {
      await rm(archiveRoot, { recursive: true, force: true });
      const items = await svc.readArchivedToday('2026-05-18');
      expect(items).toEqual([]);
    });
  });

  // ARCA-0162: readCompletedToday now reads from the archive dir (same source
  // as readArchivedToday) because the "Последние завершённые" section in
  // activeContext.md was removed by the thin-one-liner schema migration.
  // Each completed entry carries the title from the archive frontmatter.
  describe('readCompletedToday', () => {
    it('returns archived-today items with title from YAML frontmatter', async () => {
      const arcDir = join(archiveRoot, 'arcanada-ecosystem');
      await fs.mkdir(arcDir, { recursive: true });
      const filePath = join(arcDir, 'archive-ARCA-0009.md');
      await fs.writeFile(
        filePath,
        ['---', 'id: ARCA-0009', 'title: Agent Mesh archived', 'status: archived', '---', ''].join(
          '\n',
        ),
        'utf-8',
      );
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const items = await svc.readCompletedToday(today);
      expect(items.map((c) => c.id)).toContain('ARCA-0009');
      const item = items.find((c) => c.id === 'ARCA-0009');
      expect(item?.title).toBe('Agent Mesh archived');
    });

    it('falls back to first markdown heading when frontmatter has no title', async () => {
      const arcDir = join(archiveRoot, 'transcribator');
      await fs.mkdir(arcDir, { recursive: true });
      const filePath = join(arcDir, 'archive-TRANS-0060.md');
      await fs.writeFile(filePath, '# Transcribator artifact flip\n\nSome body text.', 'utf-8');
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const items = await svc.readCompletedToday(today);
      const item = items.find((c) => c.id === 'TRANS-0060');
      expect(item?.title).toBe('Transcribator artifact flip');
    });

    it('excludes cancelled archives from completed list', async () => {
      const arcDir = join(archiveRoot, 'arcanada-ecosystem');
      await fs.mkdir(arcDir, { recursive: true });
      const filePath = join(arcDir, 'archive-ARCA-0099.md');
      await fs.writeFile(
        filePath,
        ['---', 'id: ARCA-0099', 'title: Cancelled task', 'status: cancelled', '---', ''].join(
          '\n',
        ),
        'utf-8',
      );
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const items = await svc.readCompletedToday(today);
      expect(items.map((c) => c.id)).not.toContain('ARCA-0099');
    });

    it('does not depend on "Последние завершённые" section in activeContext.md', async () => {
      // activeContext.md has no "Последние завершённые" section (thin-one-liner schema)
      await writeFile(root, 'activeContext.md', '# Active Context\n\n## Active Tasks\n');
      // archive dir is empty — should return [] without error, not throw
      const items = await svc.readCompletedToday('2026-05-18');
      expect(items).toEqual([]);
    });

    it('returns empty list when archive directory missing (fail-soft)', async () => {
      await fs.rm(archiveRoot, { recursive: true, force: true });
      const items = await svc.readCompletedToday('2026-05-18');
      expect(items).toEqual([]);
    });
  });

  // ARCA-0154: distinguish a broken source (DATARIM_PATH unmounted / ENOENT)
  // from an honestly-empty one (mounted, but no matching entries today).
  describe('sourceAvailable', () => {
    it('returns true when the datarim root exists and is readable', async () => {
      expect(await svc.sourceAvailable()).toBe(true);
    });

    it('returns false when the datarim root does not exist (unmounted)', async () => {
      const orphan = DatarimReaderService.withRoot(join(root, 'does', 'not', 'exist'));
      expect(await orphan.sourceAvailable()).toBe(false);
    });

    it('returns true even when tasks.md is absent but the root is mounted (honest-empty)', async () => {
      // root exists (mounted) but no tasks.md yet — this is idle, not broken.
      expect(await svc.sourceAvailable()).toBe(true);
      expect(await svc.readActiveTasks()).toEqual([]);
    });
  });

  // ARCA-0163: KB staleness guard — detect present-but-stale KB (rsync gap)
  describe('kbFreshness', () => {
    it('returns stale=false when key files are fresh (mtime=now)', async () => {
      await writeFile(root, 'tasks.md', '');
      await writeFile(root, 'activeContext.md', '');
      await writeFile(root, 'backlog.md', '');
      // files were just written — mtime is now
      const result = await svc.kbFreshness(3);
      expect(result.stale).toBe(false);
      expect(result.ageHours).toBeLessThan(0.1);
    });

    it('returns stale=true when all key files are older than threshold', async () => {
      await writeFile(root, 'tasks.md', '');
      await writeFile(root, 'activeContext.md', '');
      await writeFile(root, 'backlog.md', '');
      // back-date all three key files by 5 hours
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      await Promise.all([
        fs.utimes(join(root, 'tasks.md'), fiveHoursAgo, fiveHoursAgo),
        fs.utimes(join(root, 'activeContext.md'), fiveHoursAgo, fiveHoursAgo),
        fs.utimes(join(root, 'backlog.md'), fiveHoursAgo, fiveHoursAgo),
      ]);
      const result = await svc.kbFreshness(3);
      expect(result.stale).toBe(true);
      expect(result.ageHours).toBeGreaterThanOrEqual(4.9);
      expect(result.lastSyncIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('threshold is configurable — stale=false at 6h threshold when file is 5h old', async () => {
      await writeFile(root, 'tasks.md', '');
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      await fs.utimes(join(root, 'tasks.md'), fiveHoursAgo, fiveHoursAgo);
      // at threshold=6h a 5h-old file is NOT stale
      const result = await svc.kbFreshness(6);
      expect(result.stale).toBe(false);
    });

    it('uses max mtime across key files — one fresh file makes KB fresh', async () => {
      await writeFile(root, 'tasks.md', '');
      await writeFile(root, 'activeContext.md', '');
      await writeFile(root, 'backlog.md', '');
      // back-date tasks.md and backlog.md but keep activeContext.md fresh
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      await fs.utimes(join(root, 'tasks.md'), fiveHoursAgo, fiveHoursAgo);
      await fs.utimes(join(root, 'backlog.md'), fiveHoursAgo, fiveHoursAgo);
      // activeContext.md mtime stays at now
      const result = await svc.kbFreshness(3);
      expect(result.stale).toBe(false);
    });

    it('returns stale=true with ageHours=Infinity when no key files exist', async () => {
      // root exists but has no key files (empty dir)
      const result = await svc.kbFreshness(3);
      expect(result.stale).toBe(true);
      expect(result.ageHours).toBe(Infinity);
    });
  });
});
