/**
 * What a client is allowed to ask the Runtime to execute.
 *
 * The Runtime is the door outward (ADR-0023): every External System is reached through a Connector
 * here, and that stays true when the *client* is the one who wants the answer. This file is the whole
 * of what stands between a browser and that door, so it is pure — no I/O, no HTTP, no store — and it
 * is tested alone before any transport exists.
 *
 * **Opening a read route does not open a write one.** That is the property, and these are the four
 * checks that make it true. They are `and`ed, never `or`ed. Where the last three are read from
 * depends on the Implementation's kind (ADR-0025):
 *
 *   1. the Operation is **on the allowlist** — deployment's decision, in the compose file, and a
 *      separate control from the rest because `mutating: false` means *changes nothing*, not *safe
 *      for a browser to invoke at will*. An LLM-touching Operation is non-mutating and costs money
 *      every time it is called. For a Dynamic Operation this is also the strongest of the four: it
 *      is the one control not in the store, so it is what stands between a mis-edited flag and a
 *      browser;
 *   2. it is **`clientReadable`** — for a built-in, its Implementation's flag, made next to the code
 *      that knows whether it holds; for a dynamic one, the field on the Operation Thing;
 *   3. it is **not `mutating`** — for a built-in, authoritative in code and deliberately not read
 *      from the Thing (`registry.ts` refuses to trust the Thing for this, because a `mutating: false`
 *      edited onto a booking would make crash recovery treat it as harmless); for a dynamic one there
 *      is no compiled author to ask, so it too comes from the Thing, and the allowlist above is what
 *      carries the weight;
 *   4. it does **not require an approval** — for a built-in, its seed's flag, the only place the inbox
 *      can see that an Operation shipped wanting one; for a dynamic one, the Thing's `requiresApproval`.
 *
 * The server checks its own allowlist before it forwards anything, and that is the whole of the outer
 * gate: `Enabled` is read here, in the Runtime, by the inbox itself. So the server narrows *which
 * names* reach this door and nothing more — it is *this* file, and the Runtime's own `Enabled` check
 * beside it, that carry the guarantee, because they run in the process that would do the executing.
 *
 * Every refusal answers `not-allowed` and says no more. Unknown, disallowed, mutating and
 * approval-guarded are one outward answer, so a browser probing the route learns nothing about which
 * Operations exist.
 */

import type { Operation } from "../domain/types.js";
import type {
    OperationContext,
    OperationImplementation,
    OperationOutcome,
    OperationRegistry,
} from "../operations/registry.js";

export type Verdict =
    | {
          allowed: true;
          /** How to run it, whichever kind it is. The only thing the caller needs. */
          execute(args: Record<string, unknown>, context: OperationContext): Promise<OperationOutcome>;
          /** Present for a built-in Operation; absent for a dynamic one, which has no code Implementation. */
          implementation?: OperationImplementation;
      }
    | { allowed: false; reason: "not-allowed" };

const REFUSED: Verdict = { allowed: false, reason: "not-allowed" };

/**
 * The four checks. Pure, and the only place they are made in this process.
 *
 * `thing` is the Operation Thing from the catalogue, or `undefined` if the caller could not read it.
 * A built-in Operation is decided from code and does not need it; a Dynamic Operation reads three of
 * its four flags from the Thing, so without it a dynamic call is refused — it cannot be trusted blind.
 */
export function decide(
    key: string,
    registry: OperationRegistry,
    allowlist: readonly string[],
    thing?: Operation,
): Verdict {
    if (!allowlist.includes(key)) return REFUSED;

    const implementation = registry.get(key);
    const dynamic = thing?.implementation === "dynamic";

    if (!dynamic) {
        if (!implementation) return REFUSED;
        if (implementation.clientReadable !== true) return REFUSED;
        if (implementation.mutating) return REFUSED;
        if (implementation.seed.requiresApproval === true) return REFUSED;
        return { allowed: true, implementation, execute: (args, ctx) => implementation.execute(args, ctx) };
    }

    // A dynamic Thing that is also registered in code is ambiguous, and the registry refuses it for
    // the Assistants; the door refuses it too, rather than pick a side.
    if (implementation) return REFUSED;
    if (thing!.clientReadable !== true) return REFUSED;
    if (thing!.mutating === true) return REFUSED;
    if (thing!.requiresApproval === true) return REFUSED;

    const executable = registry.clientExecutable(thing!);
    if (!executable) return REFUSED;
    return { allowed: true, execute: (args, ctx) => executable.execute(args, ctx) };
}
