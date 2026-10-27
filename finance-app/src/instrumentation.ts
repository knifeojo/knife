export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAlertSyncLoop } = await import("./core/alerts/scheduler");
  startAlertSyncLoop();
}
