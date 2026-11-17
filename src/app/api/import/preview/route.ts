import { body, route } from "@/server/api";
import { previewImport, previewSchema } from "@/server/import-workflow";
export const runtime = "nodejs";
export const POST = route(
  async (request, user) =>
    Response.json(
      await previewImport(
        user.id,
        await body(request, previewSchema),
        request.signal,
      ),
    ),
  true,
);
