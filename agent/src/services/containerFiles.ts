import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { containerRootfsPath, validateContainerId, AgentError } from "./lxc.js";
import type {
  DeleteFilesResult,
  FileEntry,
  ListFilesQuery,
  ListFilesResult,
  ReadFileResult,
  UploadFilePayload,
  UploadFilesResult,
  WriteFileResult,
} from "../types.js";

export const MAX_TEXT_READ_BYTES = 1_000_000;
export const MAX_TEXT_WRITE_BYTES = 2_000_000;
export const MAX_UPLOAD_FILE_BYTES = 8_000_000;
export const MAX_UPLOAD_TOTAL_BYTES = 10_000_000;
export const MAX_LIST_LIMIT = 500;
export const MAX_DELETE_PATHS = 100;
export const MAX_PATH_CHARS = 1024;

export function resolveContainerPath(root: string, userPath: unknown): string {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new AgentError("INVALID_PATH", "A container-absolute path starting with / is required.", 400);
  }
  const raw = userPath as string;
  if (raw.includes("\0")) throw new AgentError("INVALID_PATH", "Paths cannot contain NUL bytes.", 400);
  if (raw.length > MAX_PATH_CHARS) throw new AgentError("INVALID_PATH", "Path is too long.", 400);
  if (!raw.startsWith("/")) throw new AgentError("INVALID_PATH", "Only container-absolute paths starting with / are accepted.", 400);

  if (raw.split("/").includes("..")) {
    throw new AgentError("INVALID_PATH", "Parent directory references (..) are not allowed; use a direct container-absolute path.", 400);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new AgentError("INVALID_PATH", "Path escapes the container filesystem.", 400);
  }
  const parts = normalized.split("/").filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === "." || part === "..") throw new AgentError("INVALID_PATH", "Path escapes the container filesystem.", 400);
    if (part.length > 255) throw new AgentError("INVALID_PATH", `Path component is too long.`, 400);
  }
  const abs = parts.length === 0 ? root : path.join(root, ...parts);
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new AgentError("INVALID_PATH", "Path escapes the container filesystem.", 400);
  }
  return abs;
}

export function displayPath(root: string, abs: string): string {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (!rel || rel === ".") return "/";
  return `/${rel}`;
}

export function ensureRootfs(containerId: string): string {
  validateContainerId(containerId);
  const root = containerRootfsPath(containerId);
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) {
      throw new AgentError("FILESYSTEM_NOT_FOUND", "Container filesystem is not available.", 404);
    }
  } catch {
    throw new AgentError("FILESYSTEM_NOT_FOUND", "Container filesystem is not available.", 404);
  }
  return root;
}

export function assertNoEscape(root: string, target: string): void {
  try {
    const real = fs.realpathSync(target);
    const rel = path.relative(root, real);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new AgentError("TRAVERSAL_DETECTED", "Resolved target escapes the container root.", 403);
    }
  } catch (err) {
    if (err instanceof AgentError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new AgentError("NOT_FOUND", "File or directory not found.", 404);
    throw new AgentError("FILESYSTEM_ERROR", "Could not verify path on disk.", 500);
  }
}

export async function listDirectory(containerId: string, q: ListFilesQuery): Promise<ListFilesResult> {
  const root = ensureRootfs(containerId);
  const userPath = q.path ?? "/";
  const abs = resolveContainerPath(root, userPath);
  assertNoEscape(root, abs);

  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") throw new AgentError("NOT_A_DIRECTORY", "Specified path is not a directory.", 400);
    if (code === "ENOENT") throw new AgentError("NOT_FOUND", "Directory not found.", 404);
    throw new AgentError("FILESYSTEM_ERROR", "Failed to list directory.", 500);
  }

  const entries: FileEntry[] = [];
  for (const d of dirents) {
    const full = path.join(abs, d.name);
    let size = 0;
    let modified = new Date().toISOString();
    let type: "file" | "directory" | "symlink" | "other" = "other";

    try {
      const lstat = fs.lstatSync(full);
      modified = lstat.mtime.toISOString();
      if (lstat.isSymbolicLink()) {
        type = "symlink";
      } else if (lstat.isDirectory()) {
        type = "directory";
      } else if (lstat.isFile()) {
        type = "file";
        size = lstat.size;
      }
    } catch {
      // ignore
    }

    entries.push({
      name: d.name,
      path: displayPath(root, full),
      type,
      size,
      modified,
    });
  }

  // Filter & sort
  let filtered = entries;
  if (q.search) {
    const searchLower = q.search.toLowerCase();
    filtered = filtered.filter((e) => e.name.toLowerCase().includes(searchLower));
  }

  const sortKey = q.sort ?? "name";
  const order = q.order === "desc" ? -1 : 1;
  filtered.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    if (sortKey === "size") return (a.size - b.size) * order;
    if (sortKey === "modified") return (new Date(a.modified).getTime() - new Date(b.modified).getTime()) * order;
    return a.name.localeCompare(b.name) * order;
  });

  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(MAX_LIST_LIMIT, Math.max(1, q.pageSize ?? 50));
  const total = filtered.length;
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  return {
    path: displayPath(root, abs),
    entries: paged,
    total,
    page,
    pageSize,
  };
}

export function isTextContent(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 1024);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

export async function readTextFile(containerId: string, userPath: string): Promise<ReadFileResult> {
  const root = ensureRootfs(containerId);
  const abs = resolveContainerPath(root, userPath);
  assertNoEscape(root, abs);

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new AgentError("NOT_FOUND", "File not found.", 404);
    throw new AgentError("FILESYSTEM_ERROR", "Could not stat file.", 500);
  }

  if (stat.isDirectory()) {
    throw new AgentError("IS_DIRECTORY", "Path is a directory, not a file.", 400);
  }
  if (stat.size > MAX_TEXT_READ_BYTES) {
    throw new AgentError("FILE_TOO_LARGE", `File exceeds max text read size (${MAX_TEXT_READ_BYTES} bytes).`, 413);
  }

  const contentBuf = await fsp.readFile(abs);
  if (!isTextContent(contentBuf)) {
    throw new AgentError("BINARY_FILE", "File appears to be binary.", 415);
  }

  const hash = crypto.createHash("sha256").update(contentBuf).digest("hex");
  return {
    path: displayPath(root, abs),
    content: contentBuf.toString("utf8"),
    size: stat.size,
    hash,
    isText: true,
  };
}

export async function writeTextFile(
  containerId: string,
  userPath: string,
  content: string,
  expectedHash?: string
): Promise<WriteFileResult> {
  const root = ensureRootfs(containerId);
  const abs = resolveContainerPath(root, userPath);
  const buf = Buffer.from(content, "utf8");

  if (buf.length > MAX_TEXT_WRITE_BYTES) {
    throw new AgentError("PAYLOAD_TOO_LARGE", `Content exceeds write limit of ${MAX_TEXT_WRITE_BYTES} bytes.`, 413);
  }

  // Check parent directory
  const parent = path.dirname(abs);
  assertNoEscape(root, parent);

  if (expectedHash && fs.existsSync(abs)) {
    const existing = await fsp.readFile(abs);
    const existingHash = crypto.createHash("sha256").update(existing).digest("hex");
    if (existingHash !== expectedHash) {
      throw new AgentError("CONFLICT", "File has been modified concurrently.", 409);
    }
  }

  // Atomic write via temp file in the same directory
  const tmpName = `.kct_tmp_${crypto.randomBytes(8).toString("hex")}`;
  const tmpPath = path.join(parent, tmpName);
  try {
    await fsp.writeFile(tmpPath, buf, { mode: 0o644 });
    await fsp.rename(tmpPath, abs);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw new AgentError("WRITE_FAILED", `Failed to write file: ${err instanceof Error ? err.message : String(err)}`, 500);
  }

  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  return {
    path: displayPath(root, abs),
    bytesWritten: buf.length,
    hash,
  };
}

export async function createEntry(containerId: string, userPath: string, type: "file" | "directory"): Promise<void> {
  const root = ensureRootfs(containerId);
  const abs = resolveContainerPath(root, userPath);
  const parent = path.dirname(abs);
  assertNoEscape(root, parent);

  if (fs.existsSync(abs)) {
    throw new AgentError("CONFLICT", "An entry with this name already exists.", 409);
  }

  if (type === "directory") {
    await fsp.mkdir(abs, { recursive: false, mode: 0o755 });
  } else {
    await fsp.writeFile(abs, "", { mode: 0o644, flag: "wx" });
  }
}

export async function moveEntry(containerId: string, srcPath: string, destPath: string): Promise<void> {
  const root = ensureRootfs(containerId);
  const srcAbs = resolveContainerPath(root, srcPath);
  const destAbs = resolveContainerPath(root, destPath);

  assertNoEscape(root, srcAbs);
  assertNoEscape(root, path.dirname(destAbs));

  if (!fs.existsSync(srcAbs)) {
    throw new AgentError("NOT_FOUND", "Source entry not found.", 404);
  }
  if (fs.existsSync(destAbs)) {
    throw new AgentError("CONFLICT", "Destination entry already exists.", 409);
  }

  await fsp.rename(srcAbs, destAbs);
}

export async function deleteEntries(containerId: string, paths: string[]): Promise<DeleteFilesResult> {
  const root = ensureRootfs(containerId);
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new AgentError("VALIDATION", "No paths provided for deletion.", 400);
  }
  if (paths.length > MAX_DELETE_PATHS) {
    throw new AgentError("VALIDATION", `Cannot delete more than ${MAX_DELETE_PATHS} paths at once.`, 400);
  }

  const deleted: string[] = [];
  for (const userPath of paths) {
    const abs = resolveContainerPath(root, userPath);
    if (abs === root) {
      throw new AgentError("FORBIDDEN", "Cannot delete container root directory.", 403);
    }
    assertNoEscape(root, abs);

    if (fs.existsSync(abs)) {
      await fsp.rm(abs, { recursive: true, force: true });
      deleted.push(userPath);
    }
  }

  return { deleted };
}

export async function uploadFiles(containerId: string, files: UploadFilePayload[]): Promise<UploadFilesResult> {
  const root = ensureRootfs(containerId);
  if (!Array.isArray(files) || files.length === 0) {
    throw new AgentError("VALIDATION", "No files provided for upload.", 400);
  }

  let totalBytes = 0;
  const uploaded: { path: string; size: number }[] = [];

  for (const f of files) {
    const buf = Buffer.from(f.contentBase64, "base64");
    if (buf.length > MAX_UPLOAD_FILE_BYTES) {
      throw new AgentError("PAYLOAD_TOO_LARGE", `File '${f.path}' exceeds maximum size of ${MAX_UPLOAD_FILE_BYTES} bytes.`, 413);
    }
    totalBytes += buf.length;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw new AgentError("PAYLOAD_TOO_LARGE", `Batch upload exceeds total size of ${MAX_UPLOAD_TOTAL_BYTES} bytes.`, 413);
    }
  }

  for (const f of files) {
    const abs = resolveContainerPath(root, f.path);
    const parent = path.dirname(abs);
    assertNoEscape(root, parent);
    fs.mkdirSync(parent, { recursive: true });

    const buf = Buffer.from(f.contentBase64, "base64");
    await fsp.writeFile(abs, buf, { mode: 0o644 });
    uploaded.push({ path: f.path, size: buf.length });
  }

  return { uploaded };
}

export async function resolveDownload(containerId: string, userPath: string): Promise<{ absPath: string; size: number; filename: string }> {
  const root = ensureRootfs(containerId);
  const abs = resolveContainerPath(root, userPath);
  assertNoEscape(root, abs);

  const stat = await fsp.stat(abs);
  if (stat.isDirectory()) {
    throw new AgentError("IS_DIRECTORY", "Cannot download a directory directly.", 400);
  }
  return {
    absPath: abs,
    size: stat.size,
    filename: path.basename(abs),
  };
}
