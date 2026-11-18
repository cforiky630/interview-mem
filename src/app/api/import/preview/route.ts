import { body, route } from "@/server/api";
import {
  previewBatch,
  previewImport,
  previewRequestSchema,
} from "@/server/import-workflow";
export const runtime = "nodejs";
export const POST = route(async (request, user) => {
  const data = await body(request, previewRequestSchema, 1_000_000);
  return Response.json(
    "sources" in data
      ? await previewBatch(user.id, data, request.signal)
      : await previewImport(user.id, data, request.signal),
  );
}, true);
