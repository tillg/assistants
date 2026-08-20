/**
 * Compilation for a Dynamic Operation's Source (ADR-0025).
 *
 * Source is TypeScript the User wrote and the store carries. It is *stripped*, not type-checked:
 * a stored Implementation is checked by running it, the same way a stored system prompt is. Two
 * things this stage must nonetheless refuse before the sandbox ever sees the code, because the
 * sandbox has no module system and the failure there would be worse: `import`/`export`/`require`,
 * named so the User knows which; and a syntax error, reported with the compiler's own message
 * rather than a `new Function` surprise at execution time.
 */

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { compile, CompileError } from "../../src/operations/dynamic/compile.js";

describe("compile strips TypeScript and produces evaluable code", () => {
    it("strips the types and the result evaluates to an execute function", () => {
        const module = compile(
            "function execute(args: { n: number }, host: unknown): number { return args.n * 2; }",
        );
        expect(module.code).not.toContain(": number");
        const context: Record<string, unknown> = {};
        vm.runInNewContext(module.code, context);
        expect(typeof context["execute"]).toBe("function");
        expect((context["execute"] as (a: unknown) => number)({ n: 21 })).toBe(42);
    });

    it("passes JavaScript through unchanged", () => {
        const module = compile("function execute(args) { return args.n; }", "javascript");
        const context: Record<string, unknown> = {};
        vm.runInNewContext(module.code, context);
        expect((context["execute"] as (a: unknown) => number)({ n: 7 })).toBe(7);
    });
});

describe("compile refuses what the sandbox cannot host", () => {
    it("refuses import, naming the token", () => {
        try {
            compile("import { readFileSync } from 'node:fs';\nfunction execute() {}");
            expect.unreachable("import must be refused");
        } catch (error) {
            expect(error).toBeInstanceOf(CompileError);
            expect((error as CompileError).message).toContain("import");
        }
    });

    it("refuses export, naming the token", () => {
        try {
            compile("export const x = 1;\nfunction execute() {}");
            expect.unreachable("export must be refused");
        } catch (error) {
            expect(error).toBeInstanceOf(CompileError);
            expect((error as CompileError).message).toContain("export");
        }
    });

    it("refuses require, naming the token", () => {
        try {
            compile("const fs = require('node:fs');\nfunction execute() {}");
            expect.unreachable("require must be refused");
        } catch (error) {
            expect(error).toBeInstanceOf(CompileError);
            expect((error as CompileError).message).toContain("require");
        }
    });

    it("reports the compiler's message on a syntax error", () => {
        try {
            compile("function execute( { return 1; }");
            expect.unreachable("a syntax error must be refused");
        } catch (error) {
            expect(error).toBeInstanceOf(CompileError);
            expect((error as CompileError).message.length).toBeGreaterThan(0);
        }
    });
});

describe("compile caches by the source", () => {
    it("returns the same module for the same source and a fresh one after an edit", () => {
        const source = "function execute() { return 1; }";
        const first = compile(source);
        const again = compile(source);
        expect(again).toBe(first);

        const edited = compile("function execute() { return 2; }");
        expect(edited).not.toBe(first);
    });

    it("does not share a cache entry between languages", () => {
        const source = "function execute() { return 1; }";
        expect(compile(source, "javascript")).not.toBe(compile(source, "typescript"));
    });
});
