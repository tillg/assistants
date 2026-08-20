/**
 * The pieces that birth Conversations and raise Open Questions.
 *
 * They live together because they are the two ways new state enters the system, and both have to
 * agree on the idempotency key convention or recovery stops working.
 */

import { log } from "./log.js";
import { A12Client } from "./a12/client.js";
import { eq, nowIso, path as fieldPath, SPECS, ThingRepository } from "./a12/things.js";
import type {
    Assistant,
    Conversation,
    OpenQuestion,
    Stored,
} from "./domain/types.js";
import { LoopDriver, type AdvanceDeps } from "./loop/advance.js";
import { OperationRegistry } from "./operations/registry.js";
import { OperationHost } from "./operations/dynamic/host.js";
import { buildOperations } from "./operations/implementations.js";
import { FireflyConnector } from "./connectors/firefly.js";
import { Watcher } from "./watcher/watcher.js";
import { isConfigured, runMailIngest, type MailConnector } from "./watcher/mail.js";
import { EmailConnector } from "./connectors/email.js";
import { GmailConnector } from "./connectors/gmail.js";
import { ContentStoreClient } from "./a12/content.js";
import { OpenAiProvider } from "./llm/openai.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { ScriptedProvider } from "./llm/scripted.js";
import type { LlmProvider } from "./llm/provider.js";
import { loadLlmProfile, loadVisionProfile, type LlmProfile } from "./llm/profiles.js";
import { createVisionReader } from "./llm/vision.js";
import type { Config } from "./config.js";

export interface Runtime {
    client: A12Client;
    things: ThingRepository;
    registry: OperationRegistry;
    firefly: FireflyConnector;
    driver: LoopDriver;
    watcher: Watcher;
    llm: LlmProvider;
    llmProfile: LlmProfile;
    findAssistant(key: string): Promise<Stored<Assistant> | undefined>;
}

export function buildRuntime(config: Config): Runtime {
    const client = new A12Client({
        baseUrl: config.thingStoreUrl,
        username: config.thingStoreUser,
        password: config.thingStorePassword,
        keycloakUrl: config.keycloakUrl,
        keycloakRealm: config.keycloakRealm,
        keycloakClientId: config.keycloakClientId,
        locale: config.locale,
    });
    const things = new ThingRepository(client);
    const firefly = new FireflyConnector(
        config.fireflyUrl,
        config.fireflyToken,
        config.fireflyTokenFile,
        config.uiBaseUrl,
    );

    // Resolved here, at startup, rather than lazily at the first Turn: a profile that names no key
    // is somebody's half-finished edit, and the cheap moment to say so is before the Runtime
    // reports itself healthy — not hours later, inside a Conversation, as an error on a transcript.
    const llmProfile = loadLlmProfile(config.llmConfigFile);
    log.info("llm profile selected", {
        profile: llmProfile.name,
        provider: llmProfile.provider,
        model: llmProfile.model,
        endpoint: llmProfile.baseUrl,
        from: config.llmConfigFile,
    });

    // ScriptedProvider matches on the Assistant and turn currently being advanced, so the driver
    // publishes that here rather than threading it through every call signature.
    let llmContext = { assistantKey: "", turn: 0 };
    const llm = buildProvider(llmProfile, () => llmContext);

    const registry = new OperationRegistry(new OperationHost(config.dynamicOperation));

    async function findAssistant(key: string): Promise<Stored<Assistant> | undefined> {
        if (!key) return undefined;
        const found = await things.search<Assistant>(
            SPECS.Assistant_DM,
            eq(fieldPath(SPECS.Assistant_DM, "key"), key),
            2,
        );
        return found[0];
    }

    /** Create an Open Question. The Runtime writes it once here and never touches it again. */
    async function createQuestion(input: {
        conversation: Stored<Conversation>;
        assistantKey: string;
        kind: "free-text" | "confirm" | "choice" | "perform";
        prompt: string;
        options?: Array<{ value: string; label: string }>;
        subjectThingId?: string;
        idempotencyKey: string;
    }): Promise<string> {
        const created = await things.create<Record<string, unknown>>(SPECS.OpenQuestion_DM, {
            conversationId: input.conversation.thingId,
            assistantKey: input.assistantKey,
            seq: (input.conversation.data.entries ?? []).length,
            kind: input.kind,
            prompt: input.prompt,
            subjectThingId: input.subjectThingId ?? input.conversation.data.subjectThingId ?? "",
            options: input.options ?? [],
            idempotencyKey: input.idempotencyKey,
            createdByConversationId: input.conversation.thingId,
        });
        log.info("open question raised", {
            questionId: created.thingId,
            kind: input.kind,
            conversationId: input.conversation.thingId,
        });
        return created.thingId;
    }

    async function birth(input: {
        assistant: Stored<Assistant>;
        subjectThingId?: string;
        subjectModel?: string;
        scheduledFor?: string;
        prompt: string;
        title: string;
        parentConversationId?: string;
        idempotencyKey: string;
    }): Promise<string> {
        const created = await things.create<Record<string, unknown>>(SPECS.Conversation_DM, {
            assistantKey: input.assistant.data.key ?? "",
            title: input.title,
            subjectThingId: input.subjectThingId ?? "",
            subjectModel: input.subjectModel ?? "",
            // Exactly one of `subjectThingId` and `scheduledFor` is set, and which one says what gave
            // birth to this Conversation (ADR-0016). Both empty is a bug; both set is a bug.
            scheduledFor: input.scheduledFor ?? "",
            status: "running",
            waitingFor: "",
            turnCount: 0,
            maxTurns: input.assistant.data.maxTurns ?? 20,
            escalationCount: 0,
            parentConversationId: input.parentConversationId ?? "",
            entries: [
                {
                    seq: 1,
                    at: nowIso(),
                    role: "user",
                    kind: "prompt",
                    text: input.prompt,
                },
            ],
            idempotencyKey: input.idempotencyKey,
            ...(input.parentConversationId
                ? { createdByConversationId: input.parentConversationId }
                : {}),
        });
        log.info("conversation born", {
            conversationId: created.thingId,
            assistant: input.assistant.data.key,
            subject: input.subjectThingId,
        });
        return created.docRef;
    }

    const advanceDeps: AdvanceDeps = {
        things,
        registry,
        llm,
        setLlmContext(context) {
            llmContext = context;
        },
        leaseSeconds: config.leaseSeconds,
        maxEscalations: config.maxEscalations,
        llmMaxAttempts: config.llmMaxAttempts,
        defaultModel: llmProfile.model,
        raiseQuestion: (input) =>
            createQuestion({
                conversation: input.conversation,
                assistantKey: input.assistantKey,
                kind: input.kind,
                prompt: input.prompt,
                idempotencyKey: input.idempotencyKey,
            }),
    };

    const driver = new LoopDriver(advanceDeps);

    // The letterbox (ADR-0024). Built unconditionally — it is cheap, holds no socket until it is
    // asked to, and building it conditionally would mean two shapes of `Runtime` to reason about.
    // What is conditional is whether the Watcher is given anything to call: with no `MAIL_HOST`
    // there is no `pollMailbox`, and scan 0 returns without doing anything at all.
    //
    // It is built HERE, above the Operations, because it is not only the ingest's: the two document
    // readers download their attachments through the same client. One instance, so one token and
    // one 401 path, rather than two clients disagreeing about when the login expired.
    const content = new ContentStoreClient({
        baseUrl: config.thingStoreUrl,
        // The same token the JSON-RPC client holds, rather than a second login: two logins would
        // mean two tokens expiring at two different moments and two 401 paths to get right.
        tokenSource: {
            getToken: () => client.currentToken(),
            invalidate: () => client.invalidateToken(),
        },
    });

    // The optional second model. No `vision` in `llm.json` is the shipped default and not an error:
    // `createVisionReader` hands back the null reader, `document.readScan` reports itself
    // unavailable, and the ladder falls through to asking the User to type what the page says.
    const visionProfile = loadVisionProfile(config.llmConfigFile);
    const vision = createVisionReader(visionProfile, visionProfile?.apiKey);
    if (vision.available && visionProfile) {
        // Said only when it is on. Unavailable is the default, and a line about it every boot is
        // noise in the log of every stack that never wanted a vision model in the first place.
        log.info("scans can be read", {
            profile: visionProfile.name,
            provider: visionProfile.provider,
            model: visionProfile.model,
            endpoint: visionProfile.baseUrl,
            maxPages: config.visionMaxPages,
        });
    }

    registry.registerAll(
        buildOperations({
            things,
            firefly,
            content,
            vision,
            limits: { visionMaxPages: config.visionMaxPages, visionMaxBytes: config.visionMaxBytes },
            raiseQuestion: (input) =>
                createQuestion({
                    conversation: input.context.conversation,
                    assistantKey: input.context.assistant.data.key ?? "",
                    kind: input.kind,
                    prompt: input.prompt,
                    options: input.options,
                    subjectThingId: input.subjectThingId,
                    idempotencyKey: input.context.idempotencyKey,
                }),
            async callAssistant(input) {
                const callee = await findAssistant(input.assistantKey);
                if (!callee) throw new Error(`No Assistant with key "${input.assistantKey}"`);
                const docRef = await birth({
                    assistant: callee,
                    subjectThingId: input.subjectThingId,
                    subjectModel: input.subjectModel,
                    title: `${callee.data.name ?? callee.data.key} (called by ${input.context.assistant.data.key})`,
                    prompt: input.prompt,
                    parentConversationId: input.context.conversation.thingId,
                    idempotencyKey: input.context.idempotencyKey,
                });
                return docRef.slice(docRef.indexOf("/") + 1);
            },
        }),
    );

    const mailbox = buildMailbox(config);

    const watcher = new Watcher({
        things,
        driver,
        maxBirthsPerHour: config.maxBirthsPerHour,
        scheduleTimezone: config.scheduleTimezone,
        birth,
        pollMailbox: mailbox
            ? async () => {
                  const summary = await runMailIngest({
                      config: config.mail,
                      connector: mailbox,
                      content,
                      things,
                  });
                  return summary.created;
              }
            : undefined,
        mailPollIntervalMs: config.mail.pollIntervalMs,
    });

    return { client, things, registry, firefly, driver, watcher, llm, llmProfile, findAssistant };
}

/**
 * The letterbox, over whichever wire this deployment has credentials for.
 *
 * Two transports, one Connector shape, and the ingest above them cannot tell which it was handed —
 * which is the point: `watcher/mail.ts` is unchanged by the existence of the Gmail one.
 *
 * Gmail is not an upgrade so much as the only door this household has. Gmail's IMAP requires the
 * `https://mail.google.com/` scope, which requires an App Password, which requires 2FA on the
 * account; the household has none of those and does have a working OAuth grant. See
 * `connectors/gmail.ts`.
 *
 * Neither configured means no mailbox and therefore no `pollMailbox` — the shipped default, and not
 * an error: a household that has not set a letterbox up has not got one.
 */
function buildMailbox(config: Config): MailConnector | undefined {
    // The same question the ingest asks, from the same function — see `isConfigured`. This used to
    // test `config.mail.host === ""`, which is the IMAP-shaped version of the question and answers
    // "no letterbox" for a perfectly well configured Gmail deployment.
    if (!isConfigured(config.mail)) return undefined;

    const gmail = config.mail.gmail;
    if (config.mail.transport === "gmail" && !gmail?.refreshToken) {
        // A half-finished edit: the transport was named and the grant was not pasted in. Better a
        // letterbox that is visibly off than a poll that fails at its first call every minute.
        log.warn("MAIL_TRANSPORT is gmail but no GMAIL_REFRESH_TOKEN is set; the letterbox stays shut");
        return undefined;
    }

    const mailbox =
        gmail && config.mail.transport === "gmail"
            ? new GmailConnector({
                  user: gmail.user,
                  clientId: gmail.clientId,
                  clientSecret: gmail.clientSecret,
                  refreshToken: gmail.refreshToken,
              })
            : new EmailConnector({
                  host: config.mail.host,
                  port: config.mail.port,
                  user: config.mail.user,
                  password: config.mail.password,
                  secure: config.mail.secure,
              });

    // The sender *count*, not the senders: a list that grants access is worth being able to see the
    // size of at a glance, and `0` is the misconfiguration that matters. No credential of either
    // transport appears here — not the IMAP password and not one end of the OAuth grant.
    log.info("the letterbox is configured", {
        transport: config.mail.transport ?? "imap",
        host: config.mail.host,
        user: config.mail.transport === "gmail" ? gmail?.user || "me" : config.mail.user,
        folder: config.mail.folderIncoming,
        // In the log because a plaintext letterbox has to be visible somewhere a human looks.
        // `MAIL_SECURE=false` is legitimate against a server on a private network and wrong against
        // everything else, and a startup line is the cheapest place to notice which. Gmail's API is
        // HTTPS and nothing else, so the setting says nothing there.
        ...(config.mail.transport === "gmail" ? {} : { secure: config.mail.secure ?? true }),
        allowedSenders: config.mail.allowedSenders.length,
        pollIntervalMs: config.mail.pollIntervalMs,
    });
    if (config.mail.allowedSenders.length === 0) {
        log.warn(
            "the letterbox has no allowed senders, so every message will be rejected. " +
                "Set MAIL_ALLOWED_SENDERS; empty means nobody, deliberately.",
        );
    }

    return mailbox;
}

function buildProvider(
    profile: LlmProfile,
    context: () => { assistantKey: string; turn: number },
): LlmProvider {
    switch (profile.provider) {
        case "openai":
            return new OpenAiProvider(
                profile.baseUrl,
                profile.apiKey,
                fetch,
                profile.temperature,
                undefined,
                profile.systemSuffix,
            );
        case "anthropic":
            return new AnthropicProvider(profile.baseUrl, profile.apiKey, fetch, profile.systemSuffix);
        case "scripted":
            return ScriptedProvider.fromFile(profile.scriptFile, context);
    }
}

export type { OpenQuestion };
