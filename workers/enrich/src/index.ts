export interface EnrichBindings {
  DB: D1Database
}

// Epic 0 stub: log and ack every message. Real enrichment (Open-Meteo,
// USGS, sun/moon) lands in Epic 2.
export default {
  async queue(batch: MessageBatch<unknown>, _env: EnrichBindings): Promise<void> {
    for (const message of batch.messages) {
      console.log('enrich: received message', message.id)
      message.ack()
    }
  },
}
