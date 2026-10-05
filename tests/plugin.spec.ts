import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { verifySanitySignature } from "../src/worker.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const tokenRef = { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222" };
// The SDK harness resolves any secret ref to `resolved:${ref}`.
const RESOLVED_SECRET = `resolved:${tokenRef}`;

function sign(body: string, secret: string, t = Date.now()) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("base64url")}`;
}

async function setup() {
  const harness = createTestHarness({
    manifest,
    config: { projectId: "abc123", dataset: "production", apiToken: tokenRef, webhookSecret: tokenRef },
  });
  harness.seed({ companies: [{ id: COMPANY, name: "Acme" } as never] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

afterEach(() => vi.unstubAllGlobals());

describe("verifySanitySignature", () => {
  const body = '{"_id":"post-1"}';
  it("accepts a valid signature and rejects tampering, wrong secret and stale timestamps", () => {
    expect(verifySanitySignature(body, sign(body, "s3cret"), "s3cret")).toBe(true);
    expect(verifySanitySignature(body + " ", sign(body, "s3cret"), "s3cret")).toBe(false);
    expect(verifySanitySignature(body, sign(body, "other"), "s3cret")).toBe(false);
    expect(verifySanitySignature(body, sign(body, "s3cret", Date.now() - 10 * 60_000), "s3cret")).toBe(false);
    expect(verifySanitySignature(body, "garbage", "s3cret")).toBe(false);
  });
});

describe("tools", () => {
  it("query POSTs GROQ to the project host with the bearer token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: [{ _id: "post-1" }], ms: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const harness = await setup();

    const result = await harness.executeTool<{ content: string }>(
      "query",
      { query: "*[_type == $t]", params: { t: "post" } },
      { companyId: COMPANY },
    );

    expect(JSON.parse(result.content)).toEqual([{ _id: "post-1" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://abc123.api.sanity.io/v2025-02-19/data/query/production?perspective=published&returnQuery=false");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${RESOLVED_SECRET}`);
    expect(JSON.parse(String(init.body))).toEqual({ query: "*[_type == $t]", params: { t: "post" } });
  });

  it("publish sends a publish action for the draft and surfaces API errors", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { description: "Draft not found" } }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const harness = await setup();

    const result = await harness.executeTool<{ error: string }>("publish", { documentId: "drafts.post-1" }, { companyId: COMPANY });

    expect(result.error).toBe("Sanity API 409: Draft not found");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.actions[0]).toEqual({
      actionType: "sanity.action.document.publish",
      publishedId: "post-1",
      versionId: "drafts.post-1",
    });
  });
});

describe("webhook", () => {
  const rawBody = '{"_id":"post-1","_type":"post","title":"Hello"}';
  const headers = (signature: string) => ({
    "x-paperclip-company-id": COMPANY,
    "sanity-webhook-signature": signature,
    "sanity-operation": "update",
    "sanity-document-id": "post-1",
    "idempotency-key": "delivery-1",
  });

  it("creates one issue per signed delivery and ignores retries", async () => {
    const harness = await setup();
    const create = vi.spyOn(harness.ctx.issues, "create");
    const input = {
      endpointKey: "document-changed",
      headers: headers(sign(rawBody, RESOLVED_SECRET)),
      rawBody,
      parsedBody: JSON.parse(rawBody),
      requestId: "req-1",
    };

    await plugin.definition.onWebhook!(input);
    await plugin.definition.onWebhook!({ ...input, requestId: "req-2" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ companyId: COMPANY, title: "Sanity update: Hello (post-1)" });
  });

  it("rejects a bad signature", async () => {
    await setup();
    await expect(
      plugin.definition.onWebhook!({
        endpointKey: "document-changed",
        headers: headers(sign(rawBody, "wrong")),
        rawBody,
        requestId: "req-1",
      }),
    ).rejects.toThrow("Invalid Sanity webhook signature");
  });
});
