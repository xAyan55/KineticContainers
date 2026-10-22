import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export interface AgentConfig {
  nodeId: string;
  authToken: string;
  listenHost: string;
  listenPort: number;
  certPath: string;
  keyPath: string;
  lxcPath: string;
}

const DEFAULT_CONFIG_PATHS = [
  "/etc/kineticct/agent.json",
  path.join(process.cwd(), "agent.json"),
  path.join(process.cwd(), "data", "agent.json"),
];

export function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx > 2) {
        result[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        result[arg.slice(2)] = argv[++i];
      } else {
        result[arg.slice(2)] = "true";
      }
    }
  }
  return result;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AgentConfig {
  const args = parseArgs(argv);

  let fileConfig: Partial<AgentConfig> = {};
  const explicitPath = args["config"] || process.env.KCT_AGENT_CONFIG;

  if (explicitPath) {
    if (fs.existsSync(explicitPath)) {
      try {
        fileConfig = JSON.parse(fs.readFileSync(explicitPath, "utf8"));
      } catch (err) {
        throw new Error(`Failed to read config file at ${explicitPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw new Error(`Specified config file does not exist: ${explicitPath}`);
    }
  } else {
    for (const p of DEFAULT_CONFIG_PATHS) {
      if (fs.existsSync(p)) {
        try {
          fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
          break;
        } catch {
          // ignore error reading non-explicit config file
        }
      }
    }
  }

  const nodeId =
    args["node-id"] ||
    process.env.KCT_AGENT_NODE_ID ||
    fileConfig.nodeId ||
    "";

  const authToken =
    args["token"] ||
    process.env.KCT_AGENT_TOKEN ||
    fileConfig.authToken ||
    "";

  const listenHost =
    args["listen"] ||
    args["host"] ||
    process.env.KCT_AGENT_LISTEN ||
    fileConfig.listenHost ||
    "127.0.0.1";

  const listenPort = parseInt(
    args["port"] ||
      process.env.KCT_AGENT_PORT ||
      String(fileConfig.listenPort || 5433),
    10
  );

  const defaultCertDir = process.env.KCT_AGENT_DIR || (fs.existsSync("/etc/kineticct") ? "/etc/kineticct" : path.join(process.cwd(), "certs"));
  const certPath =
    args["cert"] ||
    process.env.KCT_AGENT_CERT ||
    fileConfig.certPath ||
    path.join(defaultCertDir, "cert.pem");

  const keyPath =
    args["key"] ||
    process.env.KCT_AGENT_KEY ||
    fileConfig.keyPath ||
    path.join(defaultCertDir, "key.pem");

  const lxcPath =
    args["lxc-path"] ||
    process.env.KCT_LXC_PATH ||
    fileConfig.lxcPath ||
    "/var/lib/lxc";

  return {
    nodeId,
    authToken,
    listenHost,
    listenPort: isNaN(listenPort) ? 5433 : listenPort,
    certPath,
    keyPath,
    lxcPath,
  };
}

/**
 * Ensure TLS certificate and private key exist. If missing, generate self-signed cert.
 */
export function ensureTlsCertificates(certPath: string, keyPath: string): { cert: Buffer; key: Buffer } {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
  }

  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  // Try generating with openssl if available
  let generated = false;
  const opensslBin = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return "openssl";
    } catch {
      const gitPath = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
      if (fs.existsSync(gitPath)) return gitPath;
      return null;
    }
  })();

  if (opensslBin) {
    try {
      execFileSync(
        opensslBin,
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "3650",
          "-nodes",
          "-subj",
          "/CN=KineticCT-Node-Agent",
        ],
        { stdio: "ignore" }
      );
      try {
        fs.chmodSync(keyPath, 0o600);
      } catch {
        // best effort on non-POSIX
      }
      generated = true;
    } catch {
      generated = false;
    }
  }

  if (!generated) {
    // Pure Node fallback: generate RSA key pair and self-signed X.509 cert
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });

    // Try node x509 generation or fallback openssl
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-key",
          keyPath,
          "-out",
          certPath,
          "-days",
          "3650",
          "-subj",
          "/CN=KineticCT-Node-Agent",
        ],
        { stdio: "ignore" }
      );
    } catch {
      // If openssl is completely missing, write a basic self-signed cert or throw clear instruction
      throw new Error(
        `TLS certificate not found at ${certPath} and openssl is not available to generate one. Please provide a certificate and key.`
      );
    }
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}
