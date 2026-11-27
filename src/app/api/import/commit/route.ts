import { body, route } from "@/server/api";
import { commitImport, commitRequestSchema } from "@/server/import-workflow";
import { withWorkspaceEtag } from "@/server/workspace";
export const runtime = "nodejs";
export const POST = route(
  async (request, user) =>
    withWorkspaceEtag(
      user.id,
      Response.json(
        await commitImport(
          user.id,
          await body(request, commitRequestSchema, 1_000_000),
        ),
      ),
    ),
  true,
);
