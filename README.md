# paperclip-plugin-sanity

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that connects agents to [Sanity](https://www.sanity.io) content.

- **Agent tools**:
  - `query`: runs GROQ against your dataset.
  - `mutate`: changes documents in one transaction.
  - `publish`: publishes a draft.
- **Sanity changes → issues**: a document change opens a Paperclip issue, via a signed webhook or, if Sanity cannot reach Paperclip, by polling. The issue can be assigned to an agent, which wakes it.

The plugin calls the Sanity HTTP API with plain fetch. It has no runtime dependencies.

## Install

```bash
npm install && npm run build
paperclipai plugin install /absolute/path/to/paperclip-plugin-sanity
```

## Configure (per company)

In Paperclip, open **Plugins → Sanity → Settings**:

| Field | Notes |
|---|---|
| Project ID | From sanity.io/manage. |
| Dataset | Default `production`. |
| API version | Default `2025-02-19`. From this version on, queries return published content unless you ask for drafts. |
| API token | A Sanity robot token, stored as a Paperclip secret. **The token's role is the permission boundary.** A `Viewer` token makes the plugin read-only. An `Editor` token lets agents write and publish. |
| Webhook secret | Must match the secret set on the Sanity webhook. Webhooks are rejected until this is set. |
| Paperclip project / agent for webhook issues | Optional. Where new issues go and which agent they are assigned to. |

## Agent tools

| Tool | What it does |
|---|---|
| `query` | Sends `POST /data/query/{dataset}`. Takes `params`, plus `perspective` = `published`, `drafts` or `raw`. |
| `mutate` | Sends `POST /data/mutate/{dataset}` with `returnIds` and `visibility=sync`. Supports `dryRun`. |
| `publish` | Sends `POST /data/actions/{dataset}` with `sanity.action.document.publish`, which turns `drafts.<id>` into `<id>`. |

Recommended agent workflow: write to `drafts.<id>`, let a human review it in Studio, then call `publish`. Tool output is capped at 40k characters to protect the agent's context. Project only the fields you need.

## Sanity webhook → Paperclip issue

Create the webhook in sanity.io/manage under **API → Webhooks**:

- **URL**: `https://<your-paperclip-host>/api/plugins/domgolonka.paperclip-plugin-sanity/webhooks/document-changed`
- **HTTP method**: `POST`. **Trigger on**: create, update and/or delete, plus a filter such as `_type == "post"`.
- **Projection** (optional): for example `{_id, _type, title, "op": delta::operation()}`.
- **HTTP headers**: `x-paperclip-company-id: <your Paperclip company id>`
- **Secret**: the same value as *Webhook secret* in the plugin settings.

How the plugin handles deliveries:
- It checks the `sanity-webhook-signature` header. This is HMAC-SHA256 with a 5-minute window, the same algorithm as `@sanity/webhook`.
- It ignores repeat deliveries that carry the same `idempotency-key`.
- Sanity must be able to reach your Paperclip server. On a private `local_trusted` instance, use a tunnel such as `cloudflared` or `ngrok`.

## No public URL? Poll instead of webhooks

Sanity webhooks can't call `localhost` or a private Paperclip instance. In that case, set **Poll for changes (GROQ filter)** in the plugin settings, for example:

```groq
_type in ["post", "page"]
```

- **How it works**: every minute the `poll-changes` job asks Sanity for published documents matching the filter whose `_updatedAt` changed. It opens one issue per change, using the same title, project and assignee as webhooks.
- **Nothing to expose**: all calls go out from your machine, so you need no tunnel and no webhook.
- **First run**: it only records the current time. Existing content does not flood you with issues.
- **Limits**: changes can take up to a minute to arrive. Deletions and draft-only edits are not detected; use webhooks for those.

> Don't tunnel a whole `local_trusted` Paperclip to the internet to receive webhooks. That mode has no login, so anyone with the URL would get full board access.

## Development

```bash
npm run dev        # esbuild watch; Paperclip reloads the worker on rebuild
npm test           # vitest using the SDK test harness
npm run typecheck
```

Not included yet:
- Asset upload. The host's `ctx.assets` is not supported in this SDK build, though `/assets/images/{dataset}/from-url` would work.
- Release actions.
- A custom settings UI. The auto-generated form covers every field.
