import { getAuth } from "@/server/auth";
import { privateResponse } from "@/server/api";
export const runtime = "nodejs";
async function handler(request: Request) {
  return privateResponse(await (await getAuth()).handler(request));
}
export { handler as GET, handler as POST };
