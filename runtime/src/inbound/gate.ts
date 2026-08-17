/**
 * What a client is allowed to ask the Runtime to execute.
 *
 * The Runtime is the door outward (ADR-0023): every External System is reached through a Connector
 * here, and that stays true when the *client* is the one who wants the answer. This file is the whole
 * of what stands between a browser and that door, so it is pure — no I/O, no HTTP, no store — and it
 * is tested alone before any transport exists.
 *
 * **Opening a read route does not open a write one.** That is the property, and these are the four
 * checks that make it true. They are `and`ed, never `or`ed, and two of them come from code rather
 * than from configuration or from a Thing:
 *
 *   1. the Operation is **on the allowlist** — deployment's decision, and a separate control from the
 *      rest because `mutating: false` means *changes nothing*, not *safe for a browser to invoke at
 *      will*. An LLM-touching Operation is non-mutating and costs money every time it is called;
 *   2. its Implementation declares **`clientReadable`** — the author's decision, made next to the code
 *      that knows whether it holds;
 *   3. its Implementation is **not `mutating`** — authoritative in code, and deliberately not read
 *      from the Operation Thing. `registry.ts` already refuses to trust the Thing for this, because a
 *      `mutating: false` edited onto a booking would make crash recovery treat it as harmless. The
 *      same reasoning applies with more force here, where the caller is a browser;
 *   4. its Implementation's seed does **not require an approval** — belt-and-braces with (3), and the
 *      only place the inbox can see that an Operation shipped wanting one, since `requiresApproval`
 *      is not on `OperationImplementation` and the inbox does not resolve against the catalogue.
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

import type { OperationImplementation, OperationRegistry } from "../operations/registry.js";

export type Verdict =
    | { allowed: true; implementation: OperationImplementation }
    | { allowed: false; reason: "not-allowed" };

const REFUSED: Verdict = { allowed: false, reason: "not-allowed" };

/** The four checks. Pure, and the only place they are made in this process. */
export function decide(
    key: string,
    registry: OperationRegistry,
    allowlist: readonly string[],
): Verdict {
    if (!allowlist.includes(key)) return REFUSED;

    const implementation = registry.get(key);
    if (!implementation) return REFUSED;

    if (implementation.clientReadable !== true) return REFUSED;
    if (implementation.mutating) return REFUSED;
    if (implementation.seed.requiresApproval === true) return REFUSED;

    return { allowed: true, implementation };
}
