import { createHmac, timingSafeEqual } from "node:crypto";
import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";

interface SanityConfig {
  projectId?: string;
  dataset?: string;
  apiVersion?: string;
  apiToken?: unknown;
  pollFilter?: string;
  webhookSecret?: unknown;
  webhookProjectId?: string;
  webhookAssigneeAgentId?: string;
}

type SanityDoc = Record<string, unknown> & { _id?: string; _type?: string; _createdAt?: string; _updatedAt?: string };

// ponytail: hard truncation keeps agent context small; add cursor paging if agents keep hitting it
const MAX_TOOL_CHARS = 40_000;
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;
// ponytail: more than POLL_LIMIT docs sharing one _updatedAt would stall the cursor; page by _id if that ever happens
export const POLL_LIMIT = 100;

/** Reimplements @sanity/webhook: header `t=<ms>,v1=<base64url(HMAC-SHA256(secret, "<t>.<rawBody>"))>`. */
export function verifySanitySignature(rawBody: string, header: string, secret: string, now = Date.now()): boolean {
  const match = header.trim().match(/^t=(\d+)[, ]+v1=([^, ]+)$/);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_MS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("base64url"));
  const actual = Buffer.from(match[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function clip(value: unknown): string {
  const text = JSON.stringify(value, null, 1) ?? "null";
  if (text.length <= MAX_TOOL_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_CHARS)}\n…[truncated ${text.length - MAX_TOOL_CHARS} chars — project fewer fields or add a slice like [0...20]]`;
}

function header(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

let ctx: PluginContext;
/** Companies with saved config; the host replays configChanged for each one at worker start. */
const configuredCompanies = new Set<string>();

async function getConfig(companyId: string): Promise<SanityConfig> {
  return (await ctx.config.get(companyId)) as SanityConfig;
}

async function sanityFetch(companyId: string, path: string, init: RequestInit = {}): Promise<any> {
  const cfg = await getConfig(companyId);
  if (!cfg.projectId || !cfg.apiToken) throw new Error("Sanity is not configured for this company: set projectId and apiToken.");
  const apiVersion = cfg.apiVersion || "2025-02-19";
  // Both values end up in the URL host/path, so validate them even though the schema has patterns.
  if (!/^[a-z0-9]+$/.test(cfg.projectId) || !/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) {
    throw new Error("Invalid Sanity projectId or apiVersion in plugin config.");
  }
  const token = await ctx.secrets.resolve(cfg.apiToken as never, { companyId, configPath: "apiToken" });
  const dataset = encodeURIComponent(cfg.dataset || "production");
  const url = `https://${cfg.projectId}.api.sanity.io/v${apiVersion}${path.replace("{dataset}", dataset)}`;
  const res = await ctx.http.fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.message ?? body?.error?.description ?? body?.error ?? res.statusText;
    throw new Error(`Sanity API ${res.status}: ${typeof message === "string" ? message : JSON.stringify(message)}`);
  }
  return body;
}

async function groq(companyId: string, query: string, params: unknown = {}, perspective = "published"): Promise<any> {
  const qs = new URLSearchParams({ perspective, returnQuery: "false" });
  const body = await sanityFetch(companyId, `/data/query/{dataset}?${qs}`, {
    method: "POST",
    body: JSON.stringify({ query, params }),
  });
  return body.result;
}

/** Opens one issue per change; `dedupeKey` makes webhook retries and overlapping polls no-ops. */
async function openChangeIssue(
  companyId: string,
  cfg: SanityConfig,
  change: { operation: string; documentId: string; dataset?: string; doc: SanityDoc; dedupeKey: string },
) {
  // ponytail: one state row per change, never pruned; add a cleanup job if volume gets large
  const seen = { scopeKind: "company" as const, scopeId: companyId, namespace: "sanity-change", stateKey: change.dedupeKey };
  if (await ctx.state.get(seen)) return;
  const label = change.doc.title ?? change.doc.name ?? change.doc._type;
  await ctx.issues.create({
    companyId,
    projectId: cfg.webhookProjectId || undefined,
    assigneeAgentId: cfg.webhookAssigneeAgentId || undefined,
    title: `Sanity ${change.operation}: ${label ? `${label} ` : ""}(${change.documentId})`.slice(0, 200),
    description: [
      `Sanity \`${change.operation}\` on document \`${change.documentId}\` in dataset \`${change.dataset ?? cfg.dataset ?? "production"}\`.`,
      "",
      "Document:",
      "```json",
      clip(change.doc),
      "```",
    ].join("\n"),
    originId: `sanity:${change.dedupeKey}`.slice(0, 200),
  });
  await ctx.state.set(seen, new Date().toISOString());
}

async function pollCompany(companyId: string) {
  const cfg = await getConfig(companyId);
  const filter = cfg.pollFilter?.trim();
  if (!filter) return;
  const cursor = { scopeKind: "company" as const, scopeId: companyId, namespace: "sanity-poll", stateKey: "since" };
  const since = (await ctx.state.get(cursor)) as string | null;
  if (!since) {
    // First run starts from now instead of opening an issue for every existing document.
    await ctx.state.set(cursor, new Date().toISOString());
    return;
  }
  // `>=` so documents sharing the boundary timestamp are not skipped; dedupe drops the repeats.
  const docs = (await groq(
    companyId,
    `*[(${filter}) && _updatedAt >= $since] | order(_updatedAt asc) [0...${POLL_LIMIT}]`,
    { since },
  )) as SanityDoc[];
  for (const doc of docs) {
    await openChangeIssue(companyId, cfg, {
      operation: doc._createdAt === doc._updatedAt ? "create" : "update",
      documentId: String(doc._id),
      doc,
      dedupeKey: `poll:${doc._id}@${doc._updatedAt}`,
    });
  }
  if (docs.length) await ctx.state.set(cursor, docs[docs.length - 1]._updatedAt);
}

function registerTool(name: string, run: (params: any, companyId: string) => Promise<unknown>) {
  const declaration = manifest.tools!.find((tool) => tool.name === name)!;
  ctx.tools.register(name, declaration, async (params, runCtx): Promise<ToolResult> => {
    try {
      const data = await run(params, runCtx.companyId);
      return { content: clip(data) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}

const plugin = definePlugin({
  async setup(context) {
    ctx = context;

    registerTool("query", async ({ query, params, perspective }, companyId) =>
      groq(companyId, query, params ?? {}, perspective ?? "published"),
    );

    registerTool("mutate", async ({ mutations, dryRun }, companyId) => {
      const qs = new URLSearchParams({ returnIds: "true", visibility: "sync", dryRun: String(Boolean(dryRun)) });
      return sanityFetch(companyId, `/data/mutate/{dataset}?${qs}`, {
        method: "POST",
        body: JSON.stringify({ mutations }),
      });
    });

    registerTool("publish", async ({ documentId }, companyId) => {
      const publishedId = String(documentId).replace(/^drafts\./, "");
      return sanityFetch(companyId, "/data/actions/{dataset}", {
        method: "POST",
        body: JSON.stringify({
          actions: [
            { actionType: "sanity.action.document.publish", publishedId, versionId: `drafts.${publishedId}` },
          ],
        }),
      });
    });

    ctx.jobs.register("poll-changes", async () => {
      const failures: string[] = [];
      for (const companyId of configuredCompanies) {
        try {
          await pollCompany(companyId);
        } catch (err) {
          failures.push(`${companyId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length) throw new Error(`Sanity poll failed for ${failures.join("; ")}`);
    });
  },

  // Config is read per call; this only tracks which companies to poll (and stops the host restarting the worker).
  async onConfigChanged(_config, context) {
    if (context?.companyId) configuredCompanies.add(context.companyId);
  },

  async onWebhook(input) {
    // Plugin config is per company but the webhook route is per plugin, so the caller names the company.
    const companyId = header(input.headers, "x-paperclip-company-id");
    if (!companyId) throw new Error("Missing x-paperclip-company-id header");
    const cfg = await getConfig(companyId);
    if (!cfg.webhookSecret) throw new Error("webhookSecret is not configured; refusing unsigned Sanity webhook");
    const secret = await ctx.secrets.resolve(cfg.webhookSecret as never, { companyId, configPath: "webhookSecret" });
    if (!verifySanitySignature(input.rawBody, header(input.headers, "sanity-webhook-signature") ?? "", secret)) {
      throw new Error("Invalid Sanity webhook signature");
    }

    const doc = (input.parsedBody ?? {}) as SanityDoc;
    await openChangeIssue(companyId, cfg, {
      operation: header(input.headers, "sanity-operation") ?? "change",
      documentId: header(input.headers, "sanity-document-id") ?? String(doc._id ?? "unknown"),
      dataset: header(input.headers, "sanity-dataset"),
      doc,
      // Sanity retries deliveries with the same idempotency-key.
      dedupeKey: `webhook:${header(input.headers, "idempotency-key") ?? input.requestId}`,
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
