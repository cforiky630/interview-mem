export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "APP_ERROR",
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
