import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import { titleStyleSettings, type TitleStyleSettings } from "../shared/settings";

// The Paseo client is supplied by the host at runtime. Derive its type from the
// plugin SDK contract so the bundle needs no local @getpaseo/client install.
type PaseoApi = PluginHookContext["paseo"];

// Workspace snapshots carry createdAt, which the plugin hook contract omits.
type WorkspaceSnapshotLike = { name?: string | null; createdAt?: string | null };

// The hook payload omits labels, and agents spawned by other agents or plugins are
// top-level with a null parentAgentId. They always tag themselves with a label
// pointing at the agent they came from (`paseo.parent-agent-id`,
// `help-answer.source-agent-id`, …); scheduled sessions carry `paseo.schedule-*`
// and are real sessions, so they keep their title.
type AgentSnapshotLike = { title?: string | null; labels?: Record<string, string> };

function isDelegated(snapshot: AgentSnapshotLike | undefined): boolean {
  return Object.keys(snapshot?.labels ?? {}).some((key) => key.includes("agent-id"));
}

// Who owns a workspace title: us (we may rename it again on the next session) or
// the user (frozen forever). Persisted so a daemon restart keeps the decision.
type Ownership = "plugin" | "user";
type LedgerEntry = { owner: Ownership; title: string | null; updatedAt: number };
type Ledger = { version: 1; workspaces: Record<string, LedgerEntry> };

const MAX_TITLE_CHARS = 80;
const PROMPT_SOURCE_MAX_CHARS = 600;
const GENERATE_TIMEOUT_MS = 30_000;
// A workspace nobody has named yet, or one this young, was named by the session
// that is creating it — not by the user.
const NEW_WORKSPACE_WINDOW_MS = 10 * 60_000;
const OUR_AGENT_TITLE = "会话标题生成";

const inFlight = new Set<string>();

function settingsFilePath(): string {
  const home = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
  return path.join(home, "plugin-settings", "title-style", `${titleStyleSettings.id}.json`);
}

function ledgerFilePath(): string {
  const home = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
  return path.join(home, "plugin-data", "title-style", "ownership.json");
}

let ledger: Ledger | null = null;
let ledgerWrites: Promise<void> = Promise.resolve();

async function readLedger(): Promise<Ledger> {
  if (ledger) return ledger;
  try {
    const raw = JSON.parse(await readFile(ledgerFilePath(), "utf8")) as Partial<Ledger>;
    const entries = Object.entries(raw.workspaces ?? {}).filter(
      (pair): pair is [string, LedgerEntry] =>
        typeof pair[1] === "object" && pair[1] !== null && "owner" in pair[1],
    );
    ledger = { version: 1, workspaces: Object.fromEntries(entries) };
  } catch {
    ledger = { version: 1, workspaces: {} };
  }
  return ledger;
}

async function saveLedgerEntry(workspaceId: string, entry: LedgerEntry): Promise<void> {
  const current = await readLedger();
  current.workspaces[workspaceId] = entry;
  const payload = JSON.stringify(current, null, 2);
  ledgerWrites = ledgerWrites.then(async () => {
    try {
      await mkdir(path.dirname(ledgerFilePath()), { recursive: true });
      await writeFile(ledgerFilePath(), payload, "utf8");
    } catch (error) {
      console.log(`[title-style] ledger write failed: ${String(error)}`);
    }
  });
  await ledgerWrites;
}

// A recorded entry decides on its own: it is ours only while the workspace still
// carries the exact title we wrote. Without one, only a nameless workspace or one
// created by this very session counts as ours — anything else was named by the
// user before we ever saw it, and stays that way.
function resolveOwnership(
  entry: LedgerEntry | undefined,
  currentTitle: string | null,
  workspaceCreatedAt: number,
  sessionStartedAt: number,
): Ownership {
  if (entry) return entry.owner === "plugin" && entry.title === currentTitle ? "plugin" : "user";
  if (!currentTitle) return "plugin";
  return sessionStartedAt - workspaceCreatedAt <= NEW_WORKSPACE_WINDOW_MS ? "plugin" : "user";
}

export async function readSettings(): Promise<TitleStyleSettings> {
  try {
    const raw = await readFile(settingsFilePath(), "utf8");
    const envelope = JSON.parse(raw) as { values?: unknown };
    return titleStyleSettings.schema.parse(envelope.values ?? {});
  } catch {
    return titleStyleSettings.schema.parse({});
  }
}

async function resolveModel(
  paseo: PaseoApi,
  override: string,
): Promise<{ provider: string; model?: string; thinkingOptionId?: string } | null> {
  if (override) {
    const [provider, ...rest] = override.split("/");
    if (!provider) return null;
    return { provider, model: rest.join("/") || undefined };
  }
  const { config } = await paseo.config.get();
  const metadata = (
    config as {
      metadataGeneration?: {
        providers?: Array<{ provider: string; model?: string; thinkingOptionId?: string }>;
      };
    }
  ).metadataGeneration;
  return metadata?.providers?.find((entry) => entry.provider) ?? null;
}

async function fetchFirstPrompt(
  paseo: PaseoApi,
  agentId: string,
  fallback: string,
): Promise<string> {
  try {
    const payload = (await paseo.agents.ref(agentId).timeline.refetch()) as {
      items?: Array<{ type: string; text?: string }>;
    };
    const first = payload.items?.find(
      (item) => item.type === "user_message" && typeof item.text === "string" && item.text.trim(),
    );
    if (first?.text) return first.text.trim().slice(0, PROMPT_SOURCE_MAX_CHARS);
  } catch {
    // Timeline may not be ready yet; the provisional title is a fine seed.
  }
  return fallback;
}

function extractTitle(text: string | null): string | null {
  if (!text) return null;
  const cleaned = text.trim();
  try {
    const parsed = JSON.parse(cleaned) as { title?: unknown };
    if (typeof parsed.title === "string" && parsed.title.trim()) return parsed.title.trim();
  } catch {
    // Not JSON; fall through to pattern extraction.
  }
  const match = cleaned.match(/"title"\s*:\s*"([^"]+)"/);
  if (match) return match[1].trim();
  const line = cleaned
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.replace(/^["'`\s]+|["'`\s]+$/g, "") || null : null;
}

function sanitizeTitle(title: string): string | null {
  const oneLine = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS).trim();
  return oneLine || null;
}

export async function nameWorkspace(
  paseo: PaseoApi,
  agent: PluginHookAgent,
  sessionStartedAt: number,
): Promise<void> {
  const workspaceId = agent.workspaceId;
  if (!workspaceId || agent.title === OUR_AGENT_TITLE) return;
  if (inFlight.has(workspaceId)) return;

  // The event payload carries config.title, which is unset for agents created
  // through the CLI or app composer; the provisional title lives on the snapshot.
  const agentSnapshot = (
    (await paseo.agents.ref(agent.id).refresh()) as { agent?: AgentSnapshotLike } | null
  )?.agent;
  const provisional = agent.title ?? agentSnapshot?.title ?? null;
  if (!provisional) return;
  // Subagents and agents spawned by other plugins report the same workspace; only
  // a top-level agent of the user's own session may re-title it.
  if (agent.parentAgentId || isDelegated(agentSnapshot)) {
    console.log(`[title-style] delegated agent ${agent.id}, skipping`);
    return;
  }
  console.log(
    `[title-style] agent.created: id=${agent.id} workspaceId=${workspaceId} title=${provisional}`,
  );
  inFlight.add(workspaceId);
  try {
    const settings = await readSettings();
    if (!settings.enabled) return;
    const ws = paseo.workspaces.ref(workspaceId);
    const snapshot = (await ws.refresh()) as WorkspaceSnapshotLike | null;
    const currentTitle = snapshot?.name ?? null;
    const entry = (await readLedger()).workspaces[workspaceId];
    const workspaceCreatedAt = Date.parse(snapshot?.createdAt ?? "");
    if (resolveOwnership(entry, currentTitle, workspaceCreatedAt, sessionStartedAt) === "user") {
      if (entry?.owner !== "user" || entry.title !== currentTitle) {
        await saveLedgerEntry(workspaceId, {
          owner: "user",
          title: currentTitle,
          updatedAt: Date.now(),
        });
      }
      console.log(
        `[title-style] "${currentTitle ?? "(untitled)"}" is the user's, skipping`,
      );
      return;
    }

    const model = await resolveModel(paseo, settings.model);
    if (!model) {
      console.log(
        "[title-style] no model: settings.model is empty and agents.metadataGeneration.providers is unset",
      );
      return;
    }

    const source = await fetchFirstPrompt(paseo, agent.id, provisional);
    const promptText = [
      "根据下面的用户请求，为这个编码会话生成一个标题。",
      "",
      settings.instructions,
      "",
      "用户请求：",
      '"""',
      source,
      '"""',
      "",
      '只返回 JSON，格式：{"title": "…"}，不要输出其他内容。',
    ].join("\n");

    // Create inside the target workspace so the daemon does not spawn a stray
    // directory workspace for the one-shot generator.
    const handle = await paseo.workspaces.ref(workspaceId).agents.create({
      config: {
        provider: model.provider + (model.model ? `/${model.model}` : ""),
        ...(model.thinkingOptionId ? { thinkingOptionId: model.thinkingOptionId } : {}),
      },
      title: OUR_AGENT_TITLE,
      prompt: promptText,
      // Delegate to the triggering agent (same label the daemon's MCP create_agent
      // path sets). Delegated agents skip attention broadcasts, so the generator
      // finishing never raises a notification.
      labels: { "paseo.parent-agent-id": agent.id },
    });
    let lastMessage: string | null = null;
    try {
      const result = await handle.waitForFinish(GENERATE_TIMEOUT_MS);
      lastMessage = result.lastMessage;
      if (result.status !== "idle") {
        console.log(
          `[title-style] generation ended with status ${result.status}${result.error ? `: ${result.error}` : ""}`,
        );
      }
    } finally {
      await handle.archive().catch((error) =>
        console.log(`[title-style] archiving generator failed: ${String(error)}`),
      );
    }

    const generated = sanitizeTitle(extractTitle(lastMessage) ?? "");
    if (!generated) {
      console.log("[title-style] model returned no usable title");
      return;
    }

    const titleAfterGeneration = (await ws.refresh())?.name ?? null;
    if (titleAfterGeneration !== generated) {
      await ws.setTitle(generated);
    }
    // Recorded only once the title is really in place: a failed write must not
    // make the next session think the user renamed the workspace.
    await saveLedgerEntry(workspaceId, {
      owner: "plugin",
      title: generated,
      updatedAt: Date.now(),
    });
    console.log(`[title-style] "${titleAfterGeneration ?? "(untitled)"}" -> "${generated}"`);
  } catch (error) {
    console.log(`[title-style] failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    inFlight.delete(workspaceId);
  }
}
