/**
 * All configuration comes from the environment, because the Runtime is a container in a
 * compose stack and nothing else about it should need editing to move it.
 */

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
        throw new Error(`Missing required environment variable ${name}`);
    }
    return value;
}

function optional(name: string, fallback: string): string {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
}

function number(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} is not a number: ${raw}`);
    return parsed;
}

export type LlmProviderName = "openai" | "anthropic" | "scripted";

export interface Config {
    readonly thingStoreUrl: string;
    readonly thingStoreUser: string;
    readonly thingStorePassword: string;
    /**
     * `just bootstrap` seeds the two Assistants, and an Assistant is written by the **User** only
     * — since D-007a the store refuses the `runtime` identity on `Assistant_DM`. So bootstrap
     * authenticates as the User rather than as the Runtime, which is also what puts `human` in
     * `__meta.creator` on a seeded Assistant: the provenance we actually want recorded.
     */
    readonly bootstrapUser: string;
    readonly bootstrapPassword: string;
    readonly locale: string;

    /**
     * Keycloak, not the ThingStore, is where the Runtime's credentials are checked — the store
     * only verifies the token that comes out. See {@link A12Client.login}.
     */
    readonly keycloakUrl: string;
    readonly keycloakRealm: string;
    readonly keycloakClientId: string;

    readonly fireflyUrl: string;
    /** Read from a file so the bootstrap container can hand it over through a shared volume. */
    readonly fireflyTokenFile: string;
    readonly fireflyToken: string;

    readonly llmProvider: LlmProviderName;
    readonly llmBaseUrl: string;
    readonly llmApiKey: string;
    readonly llmModel: string;
    /** Where ScriptedProvider reads its recorded responses from. */
    readonly llmScriptFile: string;

    readonly scanIntervalMs: number;
    readonly leaseSeconds: number;
    readonly maxBirthsPerHour: number;
    readonly maxEscalations: number;
    readonly llmMaxAttempts: number;
    readonly uiBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const provider = optional("LLM_PROVIDER", "scripted") as LlmProviderName;
    if (!["openai", "anthropic", "scripted"].includes(provider)) {
        throw new Error(`LLM_PROVIDER must be openai, anthropic or scripted; got ${provider}`);
    }
    void env;
    return {
        thingStoreUrl: optional("THINGSTORE_URL", "http://server:8080"),
        thingStoreUser: optional("THINGSTORE_USER", "runtime"),
        thingStorePassword: optional("THINGSTORE_PASSWORD", "assistants-runtime-dev"),
        bootstrapUser: optional("BOOTSTRAP_USER", "human"),
        bootstrapPassword: optional("BOOTSTRAP_PASSWORD", "human"),
        locale: optional("LOCALE", "en"),

        keycloakUrl: optional("KEYCLOAK_URL", "http://keycloak:8080"),
        keycloakRealm: optional("KEYCLOAK_REALM", "A12Realm"),
        keycloakClientId: optional("KEYCLOAK_CLIENT_ID", "assistants-runtime-client"),

        fireflyUrl: optional("FIREFLY_URL", "http://firefly:8080"),
        fireflyTokenFile: optional("FIREFLY_TOKEN_FILE", "/run/firefly/pat.txt"),
        fireflyToken: optional("FIREFLY_TOKEN", ""),

        llmProvider: provider,
        llmBaseUrl: optional("LLM_BASE_URL", "https://api.openai.com/v1"),
        llmApiKey: optional("LLM_API_KEY", process.env["OPENAI_API_KEY"] ?? ""),
        llmModel: optional("LLM_MODEL", "gpt-4o-mini"),
        llmScriptFile: optional("LLM_SCRIPT_FILE", "/run/fixtures/llm-script.json"),

        scanIntervalMs: number("SCAN_INTERVAL_MS", 2000),
        leaseSeconds: number("LEASE_SECONDS", 120),
        maxBirthsPerHour: number("MAX_BIRTHS_PER_HOUR", 200),
        maxEscalations: number("MAX_ESCALATIONS", 3),
        llmMaxAttempts: number("LLM_MAX_ATTEMPTS", 3),
        uiBaseUrl: optional("UI_BASE_URL", "http://localhost:8081"),
    };
}

export { required };
