import { Router } from "express";
import { z } from "zod";
import { getDb, newId, nowIso } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { getProvider } from "../services/virtualization/localAgent.js";
import { getProviderForNode } from "../services/virtualization/providerRegistry.js";
import { checkNodeHealth, getNodeContainers } from "../services/virtualization/host.js";
import { ProviderError } from "../services/virtualization/provider.js";
import {
  encryptSecret,
  generateNodeCredential,
  generateEnrollmentToken,
} from "../services/crypto.js";

export const nodesRouter = Router();
nodesRouter.use(requireAuth, requireAdmin);

type NodeRow = Record<string, unknown>;

/** Strip secrets and normalize flags. Credentials and tokens are never exposed. */
function publicNode(row: NodeRow): Record<string, unknown> {
  const {
    api_token: _token,
    auth_credential: _cred,
    cf_client_secret: _cfSecret,
    enrollment_token: _enrollToken,
    ...rest
  } = row;
  return {
    ...rest,
    has_auth_credential: Boolean(_cred || _token),
    has_cf_access: Boolean(row.cf_client_id),
    has_enrollment_token: Boolean(_enrollToken),
    is_protected: Number(row.is_protected ?? 0) === 1,
    tls_skip_verify: Number(row.tls_skip_verify ?? 0) === 1,
    last_check_ok:
      row.last_check_ok === null || row.last_check_ok === undefined
        ? null
        : Number(row.last_check_ok) === 1,
  };
}

function withManagedCount(row: NodeRow, db: ReturnType<typeof getDb>): Record<string, unknown> {
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM instances WHERE node_id = ?").get(row.id as string) as {
      n: number;
    }
  ).n;
  return { ...publicNode(row), managed_containers: n };
}

function findNode(db: ReturnType<typeof getDb>, id: string): NodeRow | undefined {
  return db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
}

export function validateRemoteEndpoint(raw: string): { endpoint: string; host: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("A remote node endpoint is required.");
  }
  let urlStr = trimmed;
  if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
    urlStr = "https://" + urlStr;
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("Invalid remote node URL format.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Remote node URL must use HTTPS (e.g. https://node.example.com). Insecure HTTP is not allowed.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Embedded credentials in the URL are not allowed.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    process.env.ALLOW_LOOPBACK_NODES !== "1" &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".localhost"))
  ) {
    throw new Error(
      "A remote node must use a public HTTPS hostname (such as a Cloudflare Tunnel URL), not a loopback address (localhost/127.0.0.1), since this controller server cannot reach the remote VPS via localhost."
    );
  }
  const normalized = trimmed.startsWith("https://")
    ? parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""))
    : trimmed;
  return { endpoint: normalized, host: parsed.host };
}

nodesRouter.get("/", (_req, res) => {
  const db = getDb();
  const nodes = db
    .prepare(
      `SELECT *, (SELECT COUNT(*) FROM instances i WHERE i.node_id = nodes.id) AS managed_containers
       FROM nodes ORDER BY CASE WHEN id = 'local' THEN 0 ELSE 1 END, created_at ASC`
    )
    .all() as (NodeRow & { managed_containers: number })[];
  res.json({
    data: {
      nodes: nodes.map((n) => {
        const { managed_containers, ...rest } = n;
        return { ...publicNode(rest), managed_containers };
      }),
      provider: getProvider().kind,
    },
  });
});

nodesRouter.get("/:id", (req, res) => {
  const db = getDb();
  const node = findNode(db, req.params.id);
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  res.json({ data: { node: withManagedCount(node, db) } });
});

/** Run a fresh health check and persist the outcome. */
nodesRouter.post("/:id/check", async (req, res) => {
  const db = getDb();
  if (!findNode(db, req.params.id)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  try {
    const check = await checkNodeHealth(db, req.params.id);
    recordAudit(db, {
      actorId: req.user!.id,
      action: "node.check",
      targetType: "node",
      targetId: req.params.id,
      detail: { status: check.status },
    });
    if (!check.ok && check.status === "unavailable") {
      res.status(409).json({
        error: { code: "REMOTE_NODE_UNSUPPORTED", message: check.detail },
        data: { check },
      });
      return;
    }
    res.status(200).json({ data: { check } });
  } catch (err) {
    if (err instanceof ProviderError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL", message: "Health check failed." } });
  }
});

/** Live container inventory with KineticCT ownership resolved. */
nodesRouter.get("/:id/containers", async (req, res) => {
  const db = getDb();
  try {
    const inventory = await getNodeContainers(db, req.params.id);
    res.json({ data: inventory });
  } catch (err) {
    if (err instanceof ProviderError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL", message: "Could not read container inventory." } });
  }
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  tls_skip_verify: z.boolean().optional(),
  cf_client_id: z.string().trim().max(255).optional().nullable(),
  cf_client_secret: z.string().trim().max(1024).optional().nullable(),
});

nodesRouter.patch("/:id", validate(patchSchema), (req, res) => {
  const db = getDb();
  const node = findNode(db, req.params.id);
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  const now = nowIso();
  if (req.body.name !== undefined) {
    db.prepare("UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?").run(
      req.body.name.trim(),
      now,
      node.id as string
    );
  }
  if (node.endpoint !== "local" && node.id !== "local") {
    if (req.body.tls_skip_verify !== undefined) {
      db.prepare("UPDATE nodes SET tls_skip_verify = ?, updated_at = ? WHERE id = ?").run(
        req.body.tls_skip_verify ? 1 : 0,
        now,
        node.id as string
      );
    }
    if (req.body.cf_client_id !== undefined) {
      const clientId = req.body.cf_client_id ? String(req.body.cf_client_id).trim() : null;
      db.prepare("UPDATE nodes SET cf_client_id = ?, updated_at = ? WHERE id = ?").run(
        clientId,
        now,
        node.id as string
      );
    }
    if (req.body.cf_client_secret !== undefined) {
      const secret = req.body.cf_client_secret ? encryptSecret(String(req.body.cf_client_secret).trim()) : null;
      db.prepare("UPDATE nodes SET cf_client_secret = ?, updated_at = ? WHERE id = ?").run(
        secret,
        now,
        node.id as string
      );
    }
  }
  recordAudit(db, {
    actorId: req.user!.id,
    action: "node.update",
    targetType: "node",
    targetId: node.id as string,
    detail: { name: req.body.name },
  });
  res.json({ data: { node: withManagedCount(findNode(db, node.id as string)!, db) } });
});

const nodeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  connection: z.enum(["local", "remote"]).optional().default("remote"),
  host_address: z.string().trim().min(1).max(1024).optional(),
  endpoint: z.string().trim().min(1).max(1024).optional(),
  api_token: z.string().max(1024).optional().default(""),
  tls_skip_verify: z.boolean().optional().default(false),
  cf_client_id: z.string().trim().max(255).optional(),
  cf_client_secret: z.string().trim().max(1024).optional(),
  generate_credential: z.boolean().optional().default(true),
});

nodesRouter.post("/", validate(nodeSchema), (req, res) => {
  const db = getDb();
  const now = nowIso();
  const connection = req.body.connection as "local" | "remote";

  if (connection === "local") {
    const existing = db
      .prepare("SELECT id FROM nodes WHERE id = 'local' OR endpoint = 'local'")
      .get() as { id: string } | undefined;
    if (existing) {
      res.status(409).json({
        error: {
          code: "LOCAL_NODE_EXISTS",
          message: "The Local Node is already registered automatically. No manual setup is needed.",
        },
      });
      return;
    }
    const id = newId("node");
    db.prepare(
      "INSERT INTO nodes (id, name, endpoint, api_token, status, node_type, provider, is_protected, created_at, updated_at) VALUES (?, ?, 'local', ?, 'unknown', 'local', 'local-lxc', 0, ?, ?)"
    ).run(id, req.body.name.trim(), String(req.body.api_token ?? ""), now, now);
    recordAudit(db, { actorId: req.user!.id, action: "node.register", targetType: "node", targetId: id });
    res.status(201).json({ data: { node: withManagedCount(findNode(db, id)!, db) } });
    return;
  }

  const rawHost = String(req.body.endpoint ?? req.body.host_address ?? "").trim();
  if (!rawHost) {
    res.status(400).json({ error: { code: "VALIDATION", message: "A host address is required for remote nodes." } });
    return;
  }
  let validated: { endpoint: string; host: string };
  try {
    validated = validateRemoteEndpoint(rawHost);
  } catch (err) {
    res.status(400).json({ error: { code: "VALIDATION", message: err instanceof Error ? err.message : "Invalid endpoint." } });
    return;
  }

  const endpoint = validated.endpoint;
  const clash = db.prepare("SELECT id FROM nodes WHERE endpoint = ? OR host_address = ?").get(endpoint, endpoint) as { id: string } | undefined;
  if (clash) {
    res.status(409).json({ error: { code: "NODE_EXISTS", message: "A node with this host address is already registered." } });
    return;
  }

  const id = newId("node");
  let rawCred = "";
  let encryptedCred: string | null = null;
  if (req.body.api_token && req.body.api_token.trim().length > 0) {
    rawCred = req.body.api_token.trim();
    encryptedCred = encryptSecret(rawCred);
  } else if (req.body.generate_credential !== false) {
    rawCred = generateNodeCredential();
    encryptedCred = encryptSecret(rawCred);
  }
  const rawEnrollToken = generateEnrollmentToken();
  const encryptedCfSecret = req.body.cf_client_secret ? encryptSecret(req.body.cf_client_secret.trim()) : null;
  const tlsSkipVerify = req.body.tls_skip_verify ? 1 : 0;
  const detail = rawCred ? "Enrolled with node credential; awaiting verification." : "Saved but not verified: remote node agents are not implemented yet.";
  const status = "unconfigured";

  db.prepare(
    `INSERT INTO nodes (
       id, name, endpoint, api_token, auth_credential, status, node_type, provider,
       host_address, last_error, is_protected, tls_skip_verify, cf_client_id, cf_client_secret,
       enrollment_token, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'remote', 'remote-agent', ?, ?, 0, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.body.name.trim(),
    endpoint,
    req.body.api_token ?? "",
    encryptedCred,
    status,
    endpoint,
    detail,
    tlsSkipVerify,
    req.body.cf_client_id ?? null,
    encryptedCfSecret,
    rawEnrollToken,
    now,
    now
  );

  recordAudit(db, {
    actorId: req.user!.id,
    action: "node.register",
    targetType: "node",
    targetId: id,
    detail: { connection: "remote", endpoint },
  });

  res.status(201).json({
    data: {
      node: withManagedCount(findNode(db, id)!, db),
      credential: rawCred || undefined,
      enrollment_token: rawEnrollToken,
    },
  });
});

/** Securely rotate node credential without disclosing the old credential. */
nodesRouter.post("/:id/rotate-credential", (req, res) => {
  const db = getDb();
  const node = findNode(db, req.params.id);
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  if (node.id === "local" || node.endpoint === "local") {
    res.status(400).json({ error: { code: "LOCAL_NODE", message: "Cannot rotate credentials on the Local Node." } });
    return;
  }
  const newCred = generateNodeCredential();
  const encCred = encryptSecret(newCred);
  const now = nowIso();
  db.prepare(
    "UPDATE nodes SET auth_credential = ?, enrolled_at = ?, updated_at = ? WHERE id = ?"
  ).run(encCred, now, now, node.id);
  recordAudit(db, {
    actorId: req.user!.id,
    action: "node.rotate_credential",
    targetType: "node",
    targetId: node.id as string,
  });
  res.json({
    data: {
      node: withManagedCount(findNode(db, node.id as string)!, db),
      credential: newCred,
    },
  });
});

/** Test connectivity to the remote agent. */
nodesRouter.post("/:id/test", async (req, res) => {
  const db = getDb();
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(req.params.id) as NodeRow | undefined;
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  try {
    const provider = getProviderForNode(node.id as string);
    const status = await provider.getNodeStatus(node.id as string);
    db.prepare("UPDATE nodes SET status = ?, last_seen_at = ?, updated_at = ?, last_error = NULL WHERE id = ?").run(
      "online",
      nowIso(),
      nowIso(),
      node.id
    );
    res.json({ data: { status } });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Node unreachable.";
    db.prepare("UPDATE nodes SET status = ?, updated_at = ?, last_error = ? WHERE id = ?").run("offline", nowIso(), errMsg, node.id);
    res.status(502).json({
      error: { code: "NODE_UNREACHABLE", message: errMsg },
    });
  }
});

nodesRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const node = findNode(db, req.params.id);
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  // The Local Node is the panel's own host: never removable via the API.
  if (node.id === "local" || Number(node.is_protected ?? 0) === 1) {
    res.status(403).json({
      error: { code: "NODE_PROTECTED", message: "The Local Node cannot be removed. It represents this panel's own host." },
    });
    return;
  }
  const attached = (db.prepare("SELECT COUNT(*) AS n FROM instances WHERE node_id = ?").get(req.params.id) as { n: number }).n;
  if (attached > 0) {
    res.status(409).json({
      error: { code: "NODE_IN_USE", message: `Node still hosts ${attached} instance record(s). Reassign or remove them first.` },
    });
    return;
  }
  db.prepare("DELETE FROM nodes WHERE id = ?").run(req.params.id);
  recordAudit(db, { actorId: req.user!.id, action: "node.remove", targetType: "node", targetId: req.params.id });
  res.json({ data: { ok: true } });
});
