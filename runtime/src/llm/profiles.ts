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
    /**
     * The profile `document.readScan` sends a PDF to, if there is one. A sibling of `active` and
     * not a field of it, because reading a scan is a different model from the one that takes Turns
     * far more often than it is the same one: the loop wants something cheap and fast, and a scan
     * wants something that can look at a page.
     */
    vision?: unknown;
    profiles?: Record<string, RawProfile>;
}

/** The file, read and checked as far as "it has profiles at all" — before any name is looked up. */
interface Catalogue {
    readonly where: string;
    readonly parsed: RawFile;
    readonly profiles: Record<string, RawProfile>;
    /** Every name the file defines, sorted, so every error can list them. */
    readonly known: string[];
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
    const catalogue = readCatalogue(file);
    const { where, known } = catalogue;

    const active = catalogue.parsed.active;
    if (typeof active !== "string" || active === "") {
        throw new ConfigurationError(
            `${where} does not say which profile is active.\n\n` +
                `  Set "active" to one of: ${known.join(", ")}`,
        );
    }
    return resolveProfile(catalogue, "active", active, env);
}

/**
 * The same, for the optional top-level `vision` key — the model `document.readScan` sends a PDF to.
 *
 * **No `vision` key is not an error.** It is the shipped default, and it means exactly one thing:
 * there is nothing to send a scan to, so `document.readScan` reports itself unavailable and the
 * ladder falls through to `document.requestText`, which asks the User to type what the page says.
 * That is today's behaviour and it is a working system, so a stack that never configures a vision
 * model must start silently rather than be nagged at every boot.
 *
 * A `vision` key that *is* present is held to exactly the same standard as `active`: naming a
 * profile that does not exist, or one that is unusable, is a half-finished edit and is said so at
 * start-up rather than discovered by the first Assistant that meets a scanned invoice.
 */
export function loadVisionProfile(
    file: string,
    env: NodeJS.ProcessEnv = process.env,
): LlmProfile | undefined {
    const catalogue = readCatalogue(file);
    const { where, known } = catalogue;

    const vision = catalogue.parsed.vision;
    if (vision === undefined || vision === null) return undefined;
    if (typeof vision !== "string" || vision === "") {
        throw new ConfigurationError(
            `${where} has a "vision" that names no profile: ${JSON.stringify(vision)}.\n\n` +
                `  known profiles   ${known.join(", ")}\n\n` +
                `Set "vision" to one of those, or remove the key altogether — without it there is ` +
                `no vision model, reading a scan is unavailable, and an Assistant that meets a PDF ` +
                `with no text layer asks the User to type it instead.`,
        );
    }
    return resolveProfile(catalogue, "vision", vision, env);
}

/**
 * Resolve and validate the profile named by one top-level key, and find its key in `env`.
 *
 * `selector` is carried through every message this can throw so that they name the key that made
 * the choice — `"active"` or `"vision"` — because "the profile X, which this file does not define"
 * is only half an instruction if it does not also say which line to change.
 */
function resolveProfile(
    catalogue: Catalogue,
    selector: "active" | "vision",
    active: string,
    env: NodeJS.ProcessEnv,
): LlmProfile {
    const { where, profiles, known } = catalogue;

    const raw = profiles[active];
    if (raw === undefined) {
        throw new ConfigurationError(
            `${where} selects the profile "${active}", which it does not define.\n\n` +
                `  known profiles   ${known.join(", ")}\n\n` +
                `Set "${selector}" to one of those, or add "${active}" under "profiles".`,
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
        throw new ConfigurationError(
            missingKeyMessage({ active, selector, where, name, baseUrl, model, apiKeyVariable, known, profiles }),
        );
    }

    return { name: active, provider: name, baseUrl, model, temperature, scriptFile, apiKey, apiKeyVariable };
}

/**
 * The file, parsed, with the one check both selectors need done once: that there are profiles in
 * it at all. Everything past this point is about a single name.
 */
function readCatalogue(file: string): Catalogue {
    const where = resolve(file);
    const parsed = readProfilesFile(file, where);

    const profiles = parsed.profiles;
    if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
        throw new ConfigurationError(`${where} has no "profiles" object. It must map a name to a configuration.`);
    }
    const known = Object.keys(profiles).sort();
    if (known.length === 0) throw new ConfigurationError(`${where} defines no profiles under "profiles".`);

    return { where, parsed, profiles, known };
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
    selector: "active" | "vision";
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
        `  selected    by "${input.selector}" in ${input.where}`,
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
