import type { AppContext, Services } from '@openagentix/api';
import {
  KafkaEventSource,
  KafkaSourceConfigSchema,
  kafkajsConsumerFactory,
  type ConsumerFactory,
} from '@openagentix/events';

/** Starts consumers for enabled Kafka event sources; each record becomes an event (+ run). */
export class KafkaSources {
  private readonly running: KafkaEventSource[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly services: Services,
    private readonly factory: ConsumerFactory = kafkajsConsumerFactory,
  ) {}

  async start(): Promise<number> {
    const sources = (await this.services.ingest.listAllSources()).filter(
      (s) => s.kind === 'kafka' && s.enabled,
    );
    for (const s of sources) {
      const cfg = KafkaSourceConfigSchema.parse({ ...(s.config as object), name: s.name });
      const src = new KafkaEventSource(cfg, this.ctx.secrets, this.factory);
      await src.start(async (event) => {
        await this.services.ingest.ingestEvent(s, event, `kafka:${s.name}`);
      });
      this.running.push(src);
      this.ctx.logger.info({ source: s.name, topics: cfg.topics }, 'kafka source started');
    }
    return sources.length;
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.running.splice(0).map((s) => s.stop()));
  }
}
