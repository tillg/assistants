/*
 * SPDX-License-Identifier: EUPL-1.2 OR LicenseRef-commercial
 *
 * Copyright (c) 2012-2026 mgm technology partners GmbH
 *
 * Dual License
 * ------------
 * This source file is part of the mgm A12 Platform and available under
 * a choice of two different licenses:
 *
 * 1. Open-Source License - EUPL v1.2
 *    You may redistribute and/or modify this file under the terms of the
 *    European Union Public License, version 1.2 - see https://eupl.eu/.
 *
 * 2. Commercial License
 *    Alternatively, you may obtain a commercial license from
 *    mgm technology partners GmbH, that permits use of this software
 *    under different terms (including support and maintenance services).
 *
 *    Please contact a12-license@mgm-tp.com for more information.
 *
 * You must select and comply with exactly one of the above license options.
 *
 * Warranty Disclaimer (applies to either option)
 * ----------------------------------------------
 * THIS SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND,
 * WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NON-INFRINGEMENT, EXCEPT WHERE SUCH DISCLAIMERS ARE HELD TO BE
 * LEGALLY INVALID. SEE THE RESPECTIVE LICENSE TEXT FOR DETAILS.
 */

/**
 * Bookkeeping — Firefly III — read side.
 *
 * ADR-0006 makes Firefly the Authority for whether an invoice is owed or paid, and nothing else
 * keeps a copy. So the only honest end-of-flow assertion is one made against Firefly's own API:
 * the invoice slice is finished when *the books* say 96.50 EUR is on them.
 */

import { execFileSync } from "node:child_process";

import { COMPOSE_ARGS, FIREFLY_URL, REPO_ROOT } from "./config";

export interface FireflySplit {
    description: string;
    amount: string;
    currency_code: string;
    type: string;
    external_id?: string | null;
    source_name?: string;
    destination_name?: string;
}

let cachedToken: string | undefined;

/**
 * The Personal Access Token the one-shot `firefly-bootstrap` container minted.
 *
 * It is written into a shared volume that only the Runtime mounts, so the cheapest way to read
 * it without guessing the compose project's volume prefix is to ask the Runtime container.
 */
export function fireflyToken(): string {
    if (cachedToken) {
        return cachedToken;
    }
    if (process.env.FIREFLY_TOKEN) {
        cachedToken = process.env.FIREFLY_TOKEN;
        return cachedToken;
    }

    const attempts: Array<[string, string[]]> = [
        ["docker", [...COMPOSE_ARGS, "exec", "-T", "runtime", "cat", "/run/firefly/pat.txt"]],
        // Not `--quiet`: it suppresses the recipe's stdout, which is the token.
        ["just", ["firefly-token"]]
    ];

    const failures: string[] = [];
    for (const [command, args] of attempts) {
        try {
            const output = execFileSync(command, args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
            if (output) {
                cachedToken = output;
                return cachedToken;
            }
        } catch (error) {
            failures.push(`${command}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        }
    }

    throw new Error(
        `Could not read the Firefly token. Set FIREFLY_TOKEN, or bring the stack up with \`just dev\`. ${failures.join("; ")}`
    );
}

async function fireflyGet<T>(path: string): Promise<T> {
    const response = await fetch(`${FIREFLY_URL.replace(/\/+$/, "")}/api/v1${path}`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${fireflyToken()}`
        }
    });
    if (!response.ok) {
        throw new Error(`Firefly GET ${path} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    return (await response.json()) as T;
}

/** Every split of every recent transaction group, newest first. */
export async function listSplits(limit = 100): Promise<FireflySplit[]> {
    const payload = await fireflyGet<{ data: Array<{ attributes: { transactions: FireflySplit[] } }> }>(
        `/transactions?limit=${limit}`
    );
    return payload.data.flatMap((group) => group.attributes.transactions ?? []);
}

/**
 * How many transactions for this amount and currency are on the books.
 *
 * A count rather than a yes/no, because a previous run's booking would make "is there one?"
 * true before this run has done anything at all.
 */
export async function countTransactions(amount: string, currency: string): Promise<number> {
    const splits = await listSplits();
    return splits.filter((split) => Number(split.amount) === Number(amount) && split.currency_code === currency).length;
}
