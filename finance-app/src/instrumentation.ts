export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAlertSyncLoop } = await import("./core/alerts/scheduler");
  startAlertSyncLoop();
  if (process.env.NODE_ENV === "test") return;
  const { backfillStatementCoverage } = await import("./core/alerts/coverage");
  backfillStatementCoverage().catch((e) => {
    console.error("[alerts.coverage] startup backfill failed", e instanceof Error ? e.message : e);
  });
  const { rebuildAllUsersFx } = await import("./core/fx/realised");
  rebuildAllUsersFx().catch((e) => {
    console.error("[fx.rebuild] startup rebuild failed", e instanceof Error ? e.message : e);
  });
}
