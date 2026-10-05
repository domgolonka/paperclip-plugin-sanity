import { createHmac, timingSafeEqual } from "node:crypto";
import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";

interface SanityConfig {
  projectId?: string;
  dataset?: string;
  apiVersion?: string;
  apiToken?: unknown;
  webhookSecret?: unknown;
  webhookProjectId?: string;
  webhookAssigneeAgentId?: string;
}

// ponytail: hard truncation keeps agent context small; add cursor paging if agents keep hitting it
const MAX_TOOL_CHARS = 40_000;
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

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

    registerTool("query", async ({ query, params, perspective }, companyId) => {
      const qs = new URLSearchParams({ perspective: perspective ?? "published", returnQuery: "false" });
      const body = await sanityFetch(companyId, `/data/query/{dataset}?${qs}`, {
        method: "POST",
        body: JSON.stringify({ query, params: params ?? {} }),
      });
      return body.result;
    });

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
  },

  // Config is read per call, so there is nothing to reload; this stops the host restarting the worker on save.
  async onConfigChanged() {},

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

    // Sanity retries deliveries with the same idempotency-key.
    // ponytail: one state row per delivery, never pruned; add a cleanup job if volume gets large
    const deliveryKey = header(input.headers, "idempotency-key") ?? input.requestId;
    const seen = { scopeKind: "company" as const, scopeId: companyId, namespace: "sanity-webhook", stateKey: deliveryKey };
    if (await ctx.state.get(seen)) return;

    const doc = (input.parsedBody ?? {}) as Record<string, unknown>;
    const operation = header(input.headers, "sanity-operation") ?? "change";
    const documentId = header(input.headers, "sanity-document-id") ?? String(doc._id ?? "unknown");
    const label = doc.title ?? doc.name ?? doc._type;
    await ctx.issues.create({
      companyId,
      projectId: cfg.webhookProjectId || undefined,
      assigneeAgentId: cfg.webhookAssigneeAgentId || undefined,
      title: `Sanity ${operation}: ${label ? `${label} ` : ""}(${documentId})`.slice(0, 200),
      description: [
        `Sanity \`${operation}\` on document \`${documentId}\` in dataset \`${header(input.headers, "sanity-dataset") ?? cfg.dataset ?? "production"}\`.`,
        "",
        "Webhook payload:",
        "```json",
        clip(doc),
        "```",
      ].join("\n"),
      originId: `sanity:${deliveryKey}`,
    });
    await ctx.state.set(seen, new Date().toISOString());
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
