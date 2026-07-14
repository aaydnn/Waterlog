export interface CronBindings {
  DB: D1Database
}

// Epic 0 stub: log the invocation. The nightly pattern recompute lands in
// Epic 4 once packages/patterns has the math.
export default {
  async scheduled(
    event: ScheduledController,
    _env: CronBindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    console.log('cron: scheduled invocation', event.cron, new Date(event.scheduledTime).toISOString())
  },
}
