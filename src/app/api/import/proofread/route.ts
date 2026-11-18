import { body, route } from "@/server/api";
import {
  proofreadImportQuestions,
  proofreadRequestSchema,
} from "@/server/import-workflow";

export const runtime = "nodejs";

export const POST = route(async (request, user) => {
  const data = await body(request, proofreadRequestSchema, 400_000);
  return Response.json(
    await proofreadImportQuestions(user.id, data, request.signal),
  );
}, true);
