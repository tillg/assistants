/**
 * Named LLM configurations, and what the Runtime says when one of them is unusable.
 *
 * The message is the feature here as much as the loading is. A profile that cannot start is
 * always somebody's half-finished edit of two files — `llm.json` and `.env` — and the only useful
 * thing to say is which name, in which file, with which variable. So the error text is asserted,
 * not merely the throwing.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigurationError, loadLlmProfile, loadVisionProfile } from "../src/llm/profiles.js";

const PROFILES = {
    active: "azure_gpt",
    profiles: {
        scripted: { provider: "scripted", scriptFile: "/run/fixtures/llm-script.json" },
        azure_gpt: {
            provider: "openai",
            baseUrl: "https://a-resource.openai.azure.com/openai/v1",
            model: "gpt-4o",
        },
        local_qwen: {
            provider: "openai",
            baseUrl: "http://host.docker.internal:8000/v1",
            model: "qwen3-coder-30b",
            temperature: 0,
            systemSuffix: "Wrap every call in <tool_call> tags.",
        },
    },
};

/** Writes a profiles file into a fresh temporary directory and returns its path. */
function fileWith(contents: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "llm-profiles-")), "llm.json");
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
    return path;
}

describe("LLM profiles", () => {
    it("resolves the active profile and reads its key from the variable named after it", () => {
        const profile = loadLlmProfile(fileWith(PROFILES), { AZURE_GPT_KEY: "sk-from-dotenv" });

        expect(profile.name).toBe("azure_gpt");
        expect(profile.provider).toBe("openai");
        expect(profile.baseUrl).toBe("https://a-resource.openai.azure.com/openai/v1");
        expect(profile.model).toBe("gpt-4o");
        expect(profile.apiKey).toBe("sk-from-dotenv");
        expect(profile.apiKeyVariable).toBe("AZURE_GPT_KEY");
    });

    it("also accepts the key spelled the way the profile is, since that is how the name reads", () => {
        // `.env` is uppercase throughout, and that is what the documentation shows — but a profile
        // is named in lower case and `azure_gpt_key` is the obvious thing to type. Both work, so
        // nobody loses an evening to the difference.
        const profile = loadLlmProfile(fileWith(PROFILES), { azure_gpt_key: "sk-lowercase" });
        expect(profile.apiKey).toBe("sk-lowercase");
    });

    it("carries the temperature only when the profile sets one", () => {
        const withTemperature = { ...PROFILES, active: "local_qwen" };
        expect(loadLlmProfile(fileWith(withTemperature), { LOCAL_QWEN_KEY: "x" }).temperature).toBe(0);
        expect(loadLlmProfile(fileWith(PROFILES), { AZURE_GPT_KEY: "x" }).temperature).toBeUndefined();
    });

    it("carries the systemSuffix only when the profile sets one", () => {
        // It is the place a model's own quirk is said out loud — a 4-bit Qwen needs to be told to
        // wrap its tool calls, and a hosted model must never be told any such thing.
        const local = loadLlmProfile(fileWith({ ...PROFILES, active: "local_qwen" }), { LOCAL_QWEN_KEY: "x" });
        expect(local.systemSuffix).toBe("Wrap every call in <tool_call> tags.");
        expect(loadLlmProfile(fileWith(PROFILES), { AZURE_GPT_KEY: "x" }).systemSuffix).toBeUndefined();
    });

    it("refuses a systemSuffix that is not a sentence, rather than appending nothing", () => {
        const broken = {
            ...PROFILES,
            active: "local_qwen",
            profiles: { ...PROFILES.profiles, local_qwen: { ...PROFILES.profiles.local_qwen, systemSuffix: "  " } },
        };

        expect(() => loadLlmProfile(fileWith(broken), { LOCAL_QWEN_KEY: "x" })).toThrow(/not a sentence/);
    });

    it("asks a scripted profile for no key at all, which is what keeps the default stack free", () => {
        const profile = loadLlmProfile(fileWith({ ...PROFILES, active: "scripted" }), {});
        expect(profile.provider).toBe("scripted");
        expect(profile.scriptFile).toBe("/run/fixtures/llm-script.json");
    });

    it("lets a profile say it needs no key, which is what a local server usually wants", () => {
        const local = {
            active: "local",
            profiles: { local: { provider: "openai", model: "m", requiresKey: false } },
        };
        expect(loadLlmProfile(fileWith(local), {}).apiKey).toBe("");
    });

    it("names the profile, the file, the variable and the remedy when the key is missing", () => {
        const file = fileWith(PROFILES);
        let message = "";
        try {
            loadLlmProfile(file, {});
        } catch (error) {
            // Its own type, so `index.ts` can print the message alone: several lines written for
            // whoever has to fix them, not a JSON-escaped field behind a stack trace.
            expect(error).toBeInstanceOf(ConfigurationError);
            message = (error as Error).message;
        }

        expect(message).toContain('"azure_gpt"');
        expect(message).toContain(file);
        expect(message).toContain("AZURE_GPT_KEY");
        expect(message).toContain(".env");
        // The endpoint and the model, so it is obvious *which* account the key has to belong to.
        expect(message).toContain("https://a-resource.openai.azure.com/openai/v1");
        expect(message).toContain("gpt-4o");
    });

    it("lists the profiles that do exist when the active one does not", () => {
        const message = attempt(fileWith({ ...PROFILES, active: "azure_gtp" }), {});
        expect(message).toContain('"azure_gtp"');
        expect(message).toContain("azure_gpt");
        expect(message).toContain("local_qwen");
        expect(message).toContain("scripted");
    });

    it("refuses a profile name that cannot become the name of a variable", () => {
        const message = attempt(
            fileWith({ active: "azure-gpt", profiles: { "azure-gpt": { provider: "openai", model: "m" } } }),
            {},
        );
        expect(message).toContain("azure-gpt");
        expect(message).toContain("letters, digits and underscores");
    });

    it("refuses a provider it has no implementation for, and says which three it has", () => {
        const message = attempt(
            fileWith({ active: "a", profiles: { a: { provider: "azure", model: "m" } } }),
            {},
        );
        expect(message).toContain("azure");
        expect(message).toContain("openai");
        expect(message).toContain("anthropic");
        expect(message).toContain("scripted");
    });

    it("refuses a profile with no model, because the profile is where the model now lives", () => {
        const message = attempt(fileWith({ active: "a", profiles: { a: { provider: "openai" } } }), {
            A_KEY: "x",
        });
        expect(message).toContain('"model"');
        expect(message).toContain('"a"');
    });

    it("says which file it could not read, rather than reporting a bare ENOENT", () => {
        const missing = join(tmpdir(), "no-such-directory-42", "llm.json");
        const message = attempt(missing, {});
        expect(message).toContain(missing);
        expect(message).toContain("LLM_CONFIG_FILE");
    });

    it("says the file is not valid JSON rather than letting the parse error stand alone", () => {
        const file = fileWith("{ active: nope }");
        const message = attempt(file, {});
        expect(message).toContain(file);
        expect(message).toContain("JSON");
    });
});

/**
 * The second, optional switch.
 *
 * Its absence is the interesting case, because it is the shipped one: no `vision` key means no
 * vision model, which means `document.readScan` says it is unavailable and the Assistant asks the
 * User to type the page instead. That is a working stack, so it must load without complaint.
 */
describe("the vision profile", () => {
    const VISION = {
        ...PROFILES,
        vision: "vision_claude",
        profiles: {
            ...PROFILES.profiles,
            vision_claude: {
                provider: "anthropic",
                baseUrl: "https://api.anthropic.com",
                model: "claude-opus-5",
            },
        },
    };

    it("is undefined when the file names none, which is the shipped default and not an error", () => {
        expect(loadVisionProfile(fileWith(PROFILES), { AZURE_GPT_KEY: "x" })).toBeUndefined();
    });

    it("resolves the profile named by \"vision\", with its own key from its own variable", () => {
        const profile = loadVisionProfile(fileWith(VISION), { VISION_CLAUDE_KEY: "sk-vision" });

        expect(profile?.name).toBe("vision_claude");
        expect(profile?.provider).toBe("anthropic");
        expect(profile?.model).toBe("claude-opus-5");
        expect(profile?.apiKey).toBe("sk-vision");
        expect(profile?.apiKeyVariable).toBe("VISION_CLAUDE_KEY");
    });

    it("names the key that made the choice when it names a profile the file does not define", () => {
        const file = fileWith({ ...VISION, vision: "vision_claud" });
        let message = "";
        try {
            loadVisionProfile(file, {});
        } catch (error) {
            expect(error).toBeInstanceOf(ConfigurationError);
            message = (error as Error).message;
        }

        expect(message).toContain('"vision_claud"');
        expect(message).toContain(file);
        // "vision", not "active": the instruction has to name the line to change.
        expect(message).toContain('Set "vision" to one of those');
        expect(message).toContain("vision_claude");
    });

    it("wants its key exactly as the active profile does, and says so the same way", () => {
        let message = "";
        try {
            loadVisionProfile(fileWith(VISION), {});
        } catch (error) {
            expect(error).toBeInstanceOf(ConfigurationError);
            message = (error as Error).message;
        }
        expect(message).toContain("VISION_CLAUDE_KEY");
        expect(message).toContain('by "vision" in');
    });

    it("leaves the active profile untouched, whether or not a vision one is configured", () => {
        // The two switches are siblings, and reading one must not disturb the other.
        const active = loadLlmProfile(fileWith(VISION), { AZURE_GPT_KEY: "sk-active" });
        expect(active.name).toBe("azure_gpt");
        expect(active.model).toBe("gpt-4o");
        expect(active.apiKey).toBe("sk-active");
    });
});

/** Runs the load expecting it to fail, and hands back the message so the test can read it. */
function attempt(file: string, env: NodeJS.ProcessEnv): string {
    try {
        loadLlmProfile(file, env);
    } catch (error) {
        return (error as Error).message;
    }
    throw new Error(`Expected ${file} to be rejected, but it loaded`);
}
