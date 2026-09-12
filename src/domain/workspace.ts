import { z } from "zod";

export const workspaceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
  storage: z.object({
    knowledge: z.literal("markdown"),
    operations: z.literal("sqlite"),
    search: z.literal("fts5"),
  }),
});

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
