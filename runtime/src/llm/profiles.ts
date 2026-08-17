/**
 * Named LLM configurations, in one file, with one switch.
 *
 * The alternative — a handful of `LLM_*` environment variables — has one configuration at a time
 * and no name for it. Keeping a second endpoint around means keeping a second set of exports
 * somewhere they will drift, and switching between them is retyping four values correctly. So the
 * *shape* of a configuration lives in `llm.json` — gitignored, written by `just setup` from the
 * committed `llm.json.example` — and `active` there is the whole of the switch.
 *
 * The secret does not live there. Each profile's key is read from `.env` — the one gitignored file
 * that already holds every secret in the stack (D-023) — under a variable named after the profile,
 * so `azure_gpt` takes `AZURE_GPT_KEY` and nothing has to be enumerated anywhere for a new profile
 * to work.
 *
 * A profile that cannot start is always a half-finished edit across those two files, and the only
 * useful thing to say is which name, in which file, needs which variable. That is what every error
 * below is for.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type LlmProviderName = "openai" | "anthropic" | "scripted";

const PROVIDERS: readonly LlmProviderName[] = ["openai", "anthropic", "scripted"];

/** Defaults per provider, so a profile only has to state what is actually its own. */
const DEFAULT_BASE_URL: Record<LlmProviderName, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    scripted: "",
};

const DEFAULT_SCRIPT_FILE = "/run/fixtures/llm-script.json";

/** A profile name becomes the name of an environment variable, so it is limited to what one may be. */
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A misconfiguration, as distinct from a fault.
 *
 * It exists so the entry point can print the message and nothing else. These messages are written
 * for whoever has to fix them, and are several lines long by design; escaped into a JSON log field
 * behind seven frames of stack they are unreadable, which is the same argument D-054 made about
 * showing stack traces to the User.
 */
export class ConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigurationError";
    }
}

export interface LlmProfile {
    /** The key under `profiles` in the file — `azure_gpt`, `local_qwen`. */
    readonly name: string;
    readonly provider: LlmProviderName;
    readonly baseUrl: string;
    /**
     * The model every Turn asks for unless the Assistant carries one of its own. It lives on the
     * profile because an endpoint and the models it serves are one decision, not two.
     */
    readonly model: string;
    /** Sent to the provider only when the profile sets it, so its own default stands otherwise. */
    readonly temperature: number | undefined;
    /** Only meaningful for `scripted`: where the recorded responses are read from. */
    readonly scriptFile: string;
    readonly apiKey: string;
    /** The variable in `.env` the key came from, or would have to come from. */
    readonly apiKeyVariable: string;
}

interface RawProfile {
    provider?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    temperature?: unknown;
    requiresKey?: unknown;
    scriptFile?: unknown;
}

interface RawFile {
    active?: unknown;
    profiles?: Record<string, RawProfile>;
}

/**
 * Read `file`, resolve the profile it declares active, and find its key in `env`.
 *
 * Throws — with a message meant for whoever has to fix it — rather than returning something
 * half-configured. The Runtime calls this while it is starting, which is the only moment a wrong
 * answer is cheap: the alternative is a Conversation that fails on its first Turn, hours later,
 * against a model nobody remembers choosing.
 */
export function loadLlmProfile(file: string, env: NodeJS.ProcessEnv = process.env): LlmProfile {
    const where = resolve(file);
    const parsed = readProfilesFile(file, where);

    const profiles = parsed.profiles;
    if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
        throw new ConfigurationError(`${where} has no "profiles" object. It must map a name to a configuration.`);
    }
    const known = Object.keys(profiles).sort();
    if (known.length === 0) throw new ConfigurationError(`${where} defines no profiles under "profiles".`);

    const active = parsed.active;
    if (typeof active !== "string" || active === "") {
        throw new ConfigurationError(
            `${where} does not say which profile is active.\n\n` +
                `  Set "active" to one of: ${known.join(", ")}`,
        );
    }
    const raw = profiles[active];
    if (raw === undefined) {
        throw new ConfigurationError(
            `${where} selects the profile "${active}", which it does not define.\n\n` +
                `  known profiles   ${known.join(", ")}\n\n` +
                `Set "active" to one of those, or add "${active}" under "profiles".`,
        );
    }
    if (!NAME.test(active)) {
        throw new ConfigurationError(
            `The LLM profile name "${active}" in ${where} cannot be used.\n\n` +
                `A profile name becomes the name of its key in .env — "${active}" would need ` +
                `${variableFor(active)} — so it may contain only letters, digits and underscores, ` +
                `and must start with a letter.`,
        );
    }

    const provider = raw.provider;
    if (typeof provider !== "string" || !PROVIDERS.includes(provider as LlmProviderName)) {
        throw new ConfigurationError(
            `The LLM profile "${active}" in ${where} has provider ${JSON.stringify(provider ?? null)}.\n\n` +
                `  supported   ${PROVIDERS.join(", ")}`,
        );
    }
    const name = provider as LlmProviderName;

    const scriptFile = string(raw.scriptFile, DEFAULT_SCRIPT_FILE, active, "scriptFile", where);
    const baseUrl = string(raw.baseUrl, DEFAULT_BASE_URL[name], active, "baseUrl", where);
    const model = string(raw.model, "", active, "model", where);
    if (name !== "scripted" && model === "") {
        throw new ConfigurationError(
            `The LLM profile "${active}" in ${where} names no "model".\n\n` +
                `The profile is where the model lives: an Assistant that carries its own overrides ` +
                `it, but the ones that do not ask for this.`,
        );
    }

    let temperature: number | undefined;
    if (raw.temperature !== undefined && raw.temperature !== null) {
        if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature)) {
            throw new ConfigurationError(
                `The LLM profile "${active}" in ${where} has a "temperature" that is not a number: ` +
                    `${JSON.stringify(raw.temperature)}`,
            );
        }
        temperature = raw.temperature;
    }

    const apiKeyVariable = variableFor(active);
    // Uppercase is what `.env` uses throughout and what the documentation shows; the profile's own
    // spelling is accepted too, because that is the obvious thing to type after naming a profile.
    const apiKey = value(env[apiKeyVariable]) ?? value(env[`${active}_key`]) ?? "";
    // `scripted` has no endpoint to authenticate against, and a local server usually has no key to
    // give — which is the setup D-054 is about, so it has to be sayable rather than worked around.
    const requiresKey = name !== "scripted" && raw.requiresKey !== false;
    if (requiresKey && apiKey === "") {
        throw new ConfigurationError(missingKeyMessage({ active, where, name, baseUrl, model, apiKeyVariable, known, profiles }));
    }

    return { name: active, provider: name, baseUrl, model, temperature, scriptFile, apiKey, apiKeyVariable };
}

function readProfilesFile(file: string, where: string): RawFile {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        throw new ConfigurationError(
            `Cannot read the LLM configuration file ${where}.\n\n` +
                `  ${(error as Error).message}\n\n` +
                `That file names every LLM configuration and says which one is active. The project ` +
                `ships one at its root; set LLM_CONFIG_FILE to read it from somewhere else.`,
        );
    }
    try {
        return JSON.parse(text) as RawFile;
    } catch (error) {
        throw new ConfigurationError(`${where} is not valid JSON.\n\n  ${(error as Error).message}`);
    }
}

/**
 * The one message that has to carry everything: which profile, chosen where, talking to what — and
 * then the exact line to add, to the exact file, and how to make it take effect.
 */
function missingKeyMessage(input: {
    active: string;
    where: string;
    name: LlmProviderName;
    baseUrl: string;
    model: string;
    apiKeyVariable: string;
    known: string[];
    profiles: Record<string, RawProfile>;
}): string {
    const keyless = input.known.filter(
        (profile) =>
            input.profiles[profile]?.provider === "scripted" ||
            input.profiles[profile]?.requiresKey === false,
    );
    return [
        `The LLM profile "${input.active}" has no API key.`,
        ``,
        `  profile     ${input.active}`,
        `  selected    by "active" in ${input.where}`,
        `  provider    ${input.name}`,
        `  endpoint    ${input.baseUrl}`,
        `  model       ${input.model}`,
        ``,
        `Add its key to .env in the project root — the gitignored file \`just setup\` writes, which`,
        `is where every secret in this stack lives:`,
        ``,
        `  ${input.apiKeyVariable}='<the key for ${input.active}>'`,
        ``,
        `Then \`just restart runtime\`. The variable is named after the profile, so each profile`,
        `keeps its own key and switching "active" needs no other edit.`,
        ...(keyless.length > 0
            ? [``, `Profiles that need no key: ${keyless.join(", ")}.`]
            : []),
    ].join("\n");
}

function variableFor(profile: string): string {
    return `${profile.toUpperCase()}_KEY`;
}

function value(raw: string | undefined): string | undefined {
    return raw === undefined || raw === "" ? undefined : raw;
}

function string(raw: unknown, fallback: string, profile: string, field: string, where: string): string {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "string") {
        throw new ConfigurationError(
            `The LLM profile "${profile}" in ${where} has a "${field}" that is not a string: ` +
                `${JSON.stringify(raw)}`,
        );
    }
    return raw;
}
