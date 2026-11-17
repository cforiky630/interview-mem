import { body, route } from "@/server/api";
import { commitImport, commitSchema } from "@/server/import-workflow";
export const runtime = "nodejs";
export const POST = route(
  async (request, user) =>
    Response.json(
      await commitImport(user.id, await body(request, commitSchema, 1_000_000)),
    ),
  true,
);
