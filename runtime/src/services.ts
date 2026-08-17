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
import { buildOperations } from "./operations/implementations.js";
import { FireflyConnector } from "./connectors/firefly.js";
import { Watcher } from "./watcher/watcher.js";
import { OpenAiProvider } from "./llm/openai.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { ScriptedProvider } from "./llm/scripted.js";
import type { LlmProvider } from "./llm/provider.js";
import { loadLlmProfile, type LlmProfile } from "./llm/profiles.js";
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

    const registry = new OperationRegistry();

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

    registry.registerAll(
        buildOperations({
            things,
            firefly,
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

    const watcher = new Watcher({
        things,
        driver,
        maxBirthsPerHour: config.maxBirthsPerHour,
        scheduleTimezone: config.scheduleTimezone,
        birth,
    });

    return { client, things, registry, firefly, driver, watcher, llm, llmProfile, findAssistant };
}

function buildProvider(
    profile: LlmProfile,
    context: () => { assistantKey: string; turn: number },
): LlmProvider {
    switch (profile.provider) {
        case "openai":
            return new OpenAiProvider(profile.baseUrl, profile.apiKey, fetch, profile.temperature);
        case "anthropic":
            return new AnthropicProvider(profile.baseUrl, profile.apiKey);
        case "scripted":
            return ScriptedProvider.fromFile(profile.scriptFile, context);
    }
}

export type { OpenQuestion };
