/**
 * Turn a Dynamic Operation's Source into an evaluable body (ADR-0025).
 *
 * TypeScript is *stripped*, not checked: `module.stripTypeScriptTypes` removes the annotations and
 * leaves the runtime semantics alone. That is the honest position — a stored Implementation is
 * checked by running it, the same way a stored system prompt is (domain.md, Result Contract).
 *
 * Two things are refused here, before the sandbox ever sees the code:
 *
 *   - `import`, `export` and `require`. The sandbox has no module loader; a `SyntaxError` from
 *     `new Function` at execution time would be a worse way to learn that than a named refusal now.
 *   - a syntax error, reported with the compiler's own message rather than surfacing three layers
 *     down as an opaque failure of the Operation.
 *
 * Results are cached by `sha256(source)` (and the language), so a Turn that calls one Operation
 * four times compiles once, and an edited Operation recompiles on the Turn after the edit with no
 * restart.
 */

import { createHash } from "node:crypto";
import module from "node:module";
import vm from "node:vm";

export type OperationLanguage = "typescript" | "javascript";

export interface CompiledModule {
    /** `sha256(source)`, hex — the cache key and the identity of this compilation. */
    readonly hash: string;
    /** TypeScript stripped, syntax-checked, ready for `vm.runInNewContext`. */
    readonly code: string;
    readonly language: OperationLanguage;
}

/** A Source that could not become a running Implementation, with a message the User can act on. */
export class CompileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CompileError";
    }
}

/**
 * The module system the sandbox does not have. Matched as statements and calls rather than as bare
 * words, so a `require` in a comment or the word "import" in a string is not a false refusal.
 */
const BANNED: ReadonlyArray<{ token: string; pattern: RegExp }> = [
    { token: "import", pattern: /^\s*import\b/m },
    { token: "export", pattern: /^\s*export\b/m },
    { token: "require", pattern: /\brequire\s*\(/ },
];

const cache = new Map<string, CompiledModule>();

export function compile(source: string, language: OperationLanguage = "typescript"): CompiledModule {
    const hash = createHash("sha256").update(source).digest("hex");
    const cacheKey = `${language}:${hash}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let code: string;
    if (language === "typescript") {
        try {
            code = module.stripTypeScriptTypes(source, { mode: "transform" });
        } catch (error) {
            throw new CompileError(error instanceof Error ? error.message : String(error));
        }
    } else {
        code = source;
    }

    for (const { token, pattern } of BANNED) {
        if (pattern.test(code)) {
            throw new CompileError(
                `Implementation Source may not use \`${token}\`: the Operation Host has no module system, ` +
                    `and everything the Source may reach is handed to it on \`host\`.`,
            );
        }
    }

    // Compile without running, so a syntax error is the compiler's message and not an execution-time
    // surprise. `new vm.Script` parses `code` exactly as the sandbox will.
    try {
        new vm.Script(code);
    } catch (error) {
        throw new CompileError(error instanceof Error ? error.message : String(error));
    }

    const compiled: CompiledModule = { hash, code, language };
    cache.set(cacheKey, compiled);
    return compiled;
}
