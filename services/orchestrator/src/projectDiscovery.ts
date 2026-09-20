import {
  ProjectListQuerySchema,
  type OrderSessionSnapshot,
  type ProjectList,
  type ProjectListQuery,
  type ProjectSummary,
} from "@molecule/contracts";
import { z } from "zod";

const CursorSchema = z.object({
  createdAt: z.iso.datetime(),
  orderId: z.string().min(1),
});
export function projectCursor(cursor?: string) {
  if (!cursor) return undefined;
  try {
    return CursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString()),
    );
  } catch {
    throw new URIError("Invalid project cursor");
  }
}

export function projectSummary(session: OrderSessionSnapshot): ProjectSummary {
  return {
    orderId: session.orderId,
    title:
      session.intent?.desiredOutputs.map(({ name }) => name).join(", ") ||
      "Untitled production project",
    state: session.state,
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function projectPage(
  projects: ProjectSummary[],
  limit: number,
): ProjectList {
  const page = projects.slice(0, limit);
  const last = page.at(-1);
  return {
    projects: page,
    nextCursor:
      projects.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt,
              orderId: last.orderId,
            }),
          ).toString("base64url")
        : null,
  };
}

export function listProjectSnapshots(
  sessions: OrderSessionSnapshot[],
  input: ProjectListQuery,
): ProjectList {
  const query = ProjectListQuerySchema.parse(input);
  const cursor = projectCursor(query.cursor);
  const search = query.search.toLowerCase();
  return projectPage(
    sessions
      .map(projectSummary)
      .filter((item) =>
        `${item.orderId} ${item.title}`.toLowerCase().includes(search),
      )
      .filter(
        (item) =>
          !cursor ||
          item.createdAt < cursor.createdAt ||
          (item.createdAt === cursor.createdAt &&
            item.orderId > cursor.orderId),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.orderId < b.orderId
            ? -1
            : a.orderId > b.orderId
              ? 1
              : 0
          : a.createdAt > b.createdAt
            ? -1
            : 1,
      ),
    query.limit,
  );
}
