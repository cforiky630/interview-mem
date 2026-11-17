export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateProductionEnvironment } =
      await import("./server/config.mjs");
    validateProductionEnvironment();
    const { getAuth } = await import("./server/auth");
    await getAuth();
    const { startQuestionTrashCleanup } =
      await import("./server/question-lifecycle");
    await startQuestionTrashCleanup();
  }
}
