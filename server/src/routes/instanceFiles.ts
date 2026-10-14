import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { ProviderError } from "../services/virtualization/provider.js";
import { containerRootfsPath } from "../services/virtualization/localAgent.js";
import {
  FileServiceError,
  createEntry,
  deleteEntries,
  listDirectory,
  mapFsError,
  moveEntry,
  readTextFile,
  resolveDownload,
  uploadFiles,
  writeTextFile,
} from "../services/virtualization/containerFiles.js";
import { getManagedInstance, type InstanceRow } from "./instances.js";

/**
 * File manager for container filesystems (`/:id/files…`, mounted under both
 * `/api/instances` and `/api/v1/instances`).
 *
 * Authorization reuses the instance ownership rule: owners manage their own
 * containers, administrators manage any container. Every handler additionally
 * verifies the instance sits on the local node — remote nodes have no file
 * agent in this build and answer 409 instead of failing later.
 *
 * All paths go through `containerFiles.ts`, which resolves them lexically
 * inside the container rootfs, refuses symlink escapes, and performs atomic
 * writes. No user-supplied path ever reaches a shell.
 */

export const instanceFilesRouter = Router();
instanceFilesRouter.use(requireAuth);

interface FileContext {
  row: InstanceRow;
  root: string;
}

function filesError(res: Response, err: unknown): void {
  if (err instanceof FileServiceError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }
  if (err instanceof ProviderError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  res.status(500).json({ error: { code: "FILESYSTEM_ERROR", message: "Filesystem operation failed." } });
}

/** Ownership + local-node + rootfs presence, in that order. */
function fileContext(req: Request): FileContext {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    throw new FileServiceError("NOT_FOUND", "Instance not found.", 404);
  }
  const nodeId = row.node_id as string | null;
  const containerId = row.container_id as string | null;
  if (!nodeId || !containerId) {
    throw new FileServiceError("NO_NODE", "Instance is not attached to a configured node.", 409);
  }
  const node = db.prepare("SELECT endpoint FROM nodes WHERE id = ?").get(nodeId) as
    | { endpoint: string }
    | undefined;
  if (!node || node.endpoint !== "local") {
    throw new FileServiceError(
      "REMOTE_NODE_UNSUPPORTED",
      "Only the local host agent is implemented; remote nodes are not connected.",
      409
    );
  }
  let root: string;
  try {
    root = containerRootfsPath(containerId);
  } catch (err) {
    throw mapFsError(err, containerId);
  }
  try {
    if (!fs.statSync(root).isDirectory()) {
      throw new FileServiceError("FILESYSTEM_NOT_FOUND", "Container filesystem is not available on this host.", 404);
    }
  } catch (err) {
    if (err instanceof FileServiceError) throw err;
    // A missing or unreadable rootfs is an honest 404, never a generic error.
    throw new FileServiceError("FILESYSTEM_NOT_FOUND", "Container filesystem is not available on this host.", 404);
  }
  return { row, root };
}

function auditFiles(req: Request, row: InstanceRow, op: string, detail: Record<string, unknown>): void {
  recordAudit(getDb(), {
    actorId: req.user!.id,
    action: "instance.files",
    targetType: "instance",
    targetId: String(row.id),
    detail: { op, container_id: row.container_id, ...detail },
  });
}

const pathQuery = z.object({ path: z.string().min(1).max(2048) });

const listQuery = z.object({
  path: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  sort: z.enum(["name", "size", "type", "mtime"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  q: z.string().trim().max(200).optional(),
});

/** Browse one directory with metadata, search, sorting, and pagination. */
instanceFilesRouter.get("/:id/files", validateQuery(listQuery), async (req, res) => {
  try {
    const { root } = fileContext(req);
    const q = (req.validatedQuery ?? {}) as {
      path?: string;
      limit?: number;
      offset?: number;
      sort?: "name" | "size" | "type" | "mtime";
      order?: "asc" | "desc";
      q?: string;
    };
    const result = await listDirectory(root, q.path ?? "/", {
      limit: q.limit,
      offset: q.offset,
      sort: q.sort,
      order: q.order,
      q: q.q,
    });
    res.json({ data: result });
  } catch (err) {
    filesError(res, err);
  }
});

/** Read a text file for the editor. Binary and oversized files are refused. */
instanceFilesRouter.get("/:id/files/content", validateQuery(pathQuery), async (req, res) => {
  try {
    const { root } = fileContext(req);
    const q = (req.validatedQuery ?? {}) as { path: string };
    const result = await readTextFile(root, q.path);
    res.json({ data: result });
  } catch (err) {
    filesError(res, err);
  }
});

const writeSchema = z.object({
  path: z.string().min(1).max(2048),
  content: z.string().max(2_500_000),
  expected_mtime: z.string().max(64).optional(),
});

/** Save editor content with optimistic concurrency and atomic replacement. */
instanceFilesRouter.put("/:id/files/content", validate(writeSchema), async (req, res) => {
  try {
    const { row, root } = fileContext(req);
    const result = await writeTextFile(root, req.body.path, req.body.content, req.body.expected_mtime);
    auditFiles(req, row, "write", { path: result.path, size: result.size });
    res.json({ data: result });
  } catch (err) {
    filesError(res, err);
  }
});

const createSchema = z.object({
  path: z.string().min(1).max(2048),
  type: z.enum(["file", "dir"]),
});

/** Create an empty file or a directory. */
instanceFilesRouter.post("/:id/files", validate(createSchema), async (req, res) => {
  try {
    const { row, root } = fileContext(req);
    const result = await createEntry(root, req.body.path, req.body.type);
    auditFiles(req, row, "create", { path: result.entry.path, type: req.body.type });
    res.status(201).json({ data: result });
  } catch (err) {
    filesError(res, err);
  }
});

const uploadFileSchema = z.object({
  name: z.string().min(1).max(255),
  content: z.string().min(1).max(12_000_000),
  overwrite: z.boolean().optional(),
});

const uploadSchema = z.object({
  path: z.string().min(1).max(2048),
  files: z.array(uploadFileSchema).min(1).max(50),
  overwrite: z.boolean().optional(),
});

/** Upload one batch of base64 files into a directory. */
instanceFilesRouter.post("/:id/files/upload", validate(uploadSchema), async (req, res) => {
  req.setTimeout(120_000);
  try {
    const { row, root } = fileContext(req);
    const result = await uploadFiles(root, req.body.path, req.body.files, req.body.overwrite);
    auditFiles(req, row, "upload", {
      path: result.path,
      files: result.files.map((f) => ({ name: f.name, size: f.size, overwritten: f.overwritten })),
    });
    res.status(201).json({ data: result });
  } catch (err) {
    filesError(res, err);
  }
});

/** Stream a regular file back as an attachment. */
instanceFilesRouter.get("/:id/files/download", validateQuery(pathQuery), async (req, res) => {
  try {
    const { root } = fileContext(req);
    const q = (req.validatedQuery ?? {}) as { path: string };
    const target = await resolveDownload(root, q.path);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(target.size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${target.filename}"; filename*=UTF-8''${encodeURIComponent(target.filename)}`
    );
    const stream = fs.createReadStream(target.abs);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: { code: "FILESYSTEM_ERROR", message: "Download failed." } });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    filesError(res, err);
  }
});

const moveSchema = z.object({
  from: z.string().min(1).max(2048),
  to: z.string().min(1).max(2048),
});

/** Rename or move a file or directory. The destination must not exist. */
instanceFilesRouter.patch("/:id/files/move", validate(moveSchema), async (req, res) => {
  try {
    const { row, root } = fileContext(req);
    const result = await moveEntry(root, req.body.from, req.body.to);
    auditFiles(req, row, "move", { from: result.from, to: result.to });
    res.json({ data: result });
  } catch (err) {
    filesError(res, err);
  }
});

const deleteSchema = z.object({
  paths: z.array(z.string().min(1).max(2048)).min(1).max(100),
});

/** Delete files and directories (recursive, confined to the container). */
instanceFilesRouter.delete("/:id/files", validate(deleteSchema), async (req, res) => {
  try {
    const { row, root } = fileContext(req);
    const result = await deleteEntries(root, req.body.paths);
    auditFiles(req, row, "delete", { paths: result.deleted });
    res.json({ data: result });
  } catch (err) {
    filesError(res, err);
  }
});
