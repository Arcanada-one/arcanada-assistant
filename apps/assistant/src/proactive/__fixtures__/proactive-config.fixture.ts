import type { ProactiveConfig } from '../proactive.types.js';

/** The shape ProactiveConfigService loads from `/etc/arcanada/proactive-config.yaml`. */
export const baseProactiveConfig: ProactiveConfig = {
  enabled: true,
  timezone: 'Europe/Istanbul',
  channels: {
    briefing: {
      enabled: true,
      cron: '0 8 * * *',
      chat_id: 100,
      include_active_tasks: true,
      include_backlog_top_n: 3,
      include_ecosystem_snapshot: true,
      include_night_events_section: false,
    },
    digest: {
      enabled: true,
      cron: '0 21 * * *',
      chat_id: 100,
      include_completed_tasks: true,
      include_archived_items: true,
      include_key_events: false,
    },
  },
  dispatch: {
    max_attempts: 3,
    base_backoff_ms: 1000,
    self_heal_threshold: 3,
    fallback_to_plain_text_on_md_error: true,
  },
  observability: { pino_level: 'info', prometheus_counter: 'assistant_proactive_dispatched_total' },
};
