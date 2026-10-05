import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "domgolonka.paperclip-plugin-sanity",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Sanity",
  description:
    "Sanity CMS connector: agents query content with GROQ, write drafts, and publish. Sanity webhooks open Paperclip issues.",
  author: "Dominik Golonka",
  categories: ["connector"],
  capabilities: [
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "jobs.schedule",
    "issues.create",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    required: ["projectId", "apiToken"],
    properties: {
      projectId: { type: "string", title: "Sanity project ID", pattern: "^[a-z0-9]+$" },
      dataset: { type: "string", title: "Dataset", default: "production" },
      apiVersion: {
        type: "string",
        title: "API version",
        description: "Sanity API version date (YYYY-MM-DD).",
        default: "2025-02-19",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      },
      apiToken: {
        format: "secret-ref",
        title: "API token",
        description:
          "Sanity robot token. Its role sets what agents can do: Viewer is read-only, Editor can write and publish.",
      },
      pollFilter: {
        type: "string",
        title: "Poll for changes (GROQ filter)",
        description:
          "Alternative to webhooks when Sanity cannot reach Paperclip (e.g. localhost). Every minute, published documents matching this filter that changed are turned into issues. Example: _type in [\"post\", \"page\"]. Leave empty to disable. Deletions are not detected.",
      },
      webhookSecret: {
        format: "secret-ref",
        title: "Webhook secret",
        description: "The secret set on the Sanity webhook. Webhooks are rejected until this is set.",
      },
      webhookProjectId: {
        type: "string",
        title: "Paperclip project for change issues",
        description: "Optional. Issues created from Sanity webhooks or polling go to this Paperclip project.",
      },
      webhookAssigneeAgentId: {
        type: "string",
        title: "Agent to assign change issues to",
        description: "Optional. Paperclip agent ID that is assigned (and woken) for each change issue.",
      },
    },
  },
  jobs: [
    {
      jobKey: "poll-changes",
      displayName: "Poll Sanity for changes",
      description: "Opens issues for documents matching each company's pollFilter that changed since the last run.",
      schedule: "* * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: "document-changed",
      displayName: "Sanity document changed",
      description:
        "Point a Sanity GROQ webhook here. Add HTTP header x-paperclip-company-id with your company ID and set a secret.",
    },
  ],
  tools: [
    {
      name: "query",
      displayName: "Sanity: GROQ query",
      description:
        "Run a GROQ query against the Sanity dataset. Use params for user input instead of string interpolation. Project only the fields you need, e.g. *[_type == \"post\"][0...10]{_id, title, slug}. perspective \"drafts\" includes unpublished edits.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "GROQ query." },
          params: { type: "object", description: "Query parameters, referenced as $name in the query." },
          perspective: { type: "string", enum: ["published", "drafts", "raw"], default: "published" },
        },
        required: ["query"],
      },
    },
    {
      name: "mutate",
      displayName: "Sanity: mutate documents",
      description:
        "Apply Sanity mutations in one transaction (create, createOrReplace, createIfNotExists, patch, delete). Write to \"drafts.<id>\" to create or edit a draft that editors can review, then call publish. Example: [{\"patch\": {\"id\": \"drafts.abc\", \"set\": {\"title\": \"New\"}}}]. Use dryRun to validate first.",
      parametersSchema: {
        type: "object",
        properties: {
          mutations: { type: "array", items: { type: "object" }, minItems: 1 },
          dryRun: { type: "boolean", default: false },
        },
        required: ["mutations"],
      },
    },
    {
      name: "publish",
      displayName: "Sanity: publish draft",
      description: "Publish the current draft of a document (drafts.<id> becomes <id>).",
      parametersSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Document ID, with or without the drafts. prefix." },
        },
        required: ["documentId"],
      },
    },
  ],
};

export default manifest;
