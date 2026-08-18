/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

/**
 * A letterbox the end-to-end tier owns, because the one the stack ships is deliberately empty.
 *
 * `MAIL_HOST` in `.env` is `''` — the shipped default, and not an error: no mailbox is configured,
 * so scan 5 never runs. A test cannot append to a mailbox that does not exist, and pointing this
 * tier at a real Gmail account would make the suite depend on a credential, a network and a third
 * party's rate limiter. So the tier brings its own IMAP server: **GreenMail, in a container, on the
 * stack's own compose network**, which is the same server `runtime/test/integration/mail-imap.itest.ts`
 * drives and therefore not a new kind of trust.
 *
 * Two addresses, one server, and the difference matters:
 *
 *   - the **Runtime** reaches it as `assistants-mail-e2e:3143`, by container name over the compose
 *     network, which is why it has to be on that network rather than merely published;
 *   - **this process** reaches it as `127.0.0.1:34243`, over the published port, and that is how the
 *     `.eml` gets in. `127.0.0.1` and not `localhost` for the reason `config.ts` spells out.
 *
 * **Plaintext, and said out loud.** GreenMail's IMAPS certificate is self-signed with no SAN and a
 * CN of "GreenMail selfsigned Test Certificate", so no amount of CA trust makes hostname
 * verification pass. Reaching it over TLS would have meant a setting that keeps TLS and stops
 * verifying it, which is the option that ends up in a production `.env`. `MAIL_SECURE=false` buys
 * plaintext instead: visible in the override, named in the Runtime's startup line, greppable.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ImapFlow } from "imapflow";

import { REPO_ROOT } from "./config";
import { sleep } from "./thingstore";

/** How the Runtime addresses it: a container name on the compose network, and GreenMail's IMAP port. */
export const MAILBOX_CONTAINER = "assistants-mail-e2e";
export const MAILBOX_CONTAINER_PORT = 3143;

/** How this process addresses it. Not 34143 — that is the integration tier's, and both may be up. */
const HOST = "127.0.0.1";
const HOST_PORT = 34243;

export const MAILBOX_USER = "receptionist";
export const MAILBOX_PASSWORD = "secret";

const IMAGE = "greenmail/standalone:2.1.0";

/**
 * The folders, spelled as `.env.example` spells them, because that is what is under test.
 *
 * GreenMail's hierarchy delimiter is `.`, so `assistants/processed` is one flat mailbox whose *name*
 * contains a slash rather than a child of `assistants`. Gmail's delimiter is `/`, where the same four
 * names really are a label and three sub-labels. Both work, and only because nothing in the Connector
 * or the ingest ever asks about hierarchy — the four names are opaque strings passed through.
 */
export const MAILBOX_FOLDERS = {
    incoming: "assistants",
    processed: "assistants/processed",
    failed: "assistants/failed",
    rejected: "assistants/rejected"
} as const;

/** The parser's own fixtures, read from where they live. A second copy would drift from the first. */
const FIXTURES = path.join(REPO_ROOT, "runtime", "test", "fixtures", "mail");

function docker(...args: string[]): string {
    return execFileSync("docker", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The network the stack is actually on, asked of the stack rather than assumed.
 *
 * Compose names it `<project>_a12_compose`, and the project name is `PROJECT_NAME` in `.env` with a
 * fallback — so writing the name out here would be a third place that has to agree with two others.
 * The Runtime container is on exactly one network and it is the one the new container has to join.
 */
function composeNetwork(): string {
    const found = docker(
        "inspect",
        "-f",
        "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}",
        "assistants_runtime"
    )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (found.length !== 1) {
        throw new Error(`Expected assistants_runtime on exactly one network, found: ${found.join(", ") || "none"}`);
    }
    return found[0]!;
}

/**
 * One `.eml` fixture, with its identity made unique to this run.
 *
 * Two header rewrites, and each one earns its place:
 *
 *   - **`Message-ID`**, because the ingest is idempotent by `ExternalRef` — `<message-id>#<part>`.
 *     Appending the fixture unchanged a second time creates *nothing*, correctly, which would make
 *     this spec pass on the first run of the day and fail on the second.
 *   - **`Subject`**, because the subject becomes `Document.Title`, and `0-clean.setup.ts` recognises
 *     what this tier left behind by the `E2E` prefix on exactly that field. Without it the Documents
 *     accumulate for ever.
 *
 * Both are ASCII header lines, replaced in the bytes rather than by re-serialising a parsed message:
 * the fixture is CRLF (see `.gitattributes`) and MIME boundary and base64 handling depend on the
 * exact bytes, so nothing here may rewrite the body.
 */
export function stampedFixture(
    name: string,
    runId: string
): { bytes: Buffer; messageId: string; subject: string; externalRef: string } {
    const raw = readFileSync(path.join(FIXTURES, name)).toString("binary");

    const idMatch = /^Message-ID: <([^>]+)>$/m.exec(raw);
    const subjectMatch = /^Subject: (.+)$/m.exec(raw);
    if (!idMatch || !subjectMatch) {
        throw new Error(`${name} has no Message-ID or no Subject to stamp`);
    }

    const [local, domain] = idMatch[1]!.split("@");
    const messageId = `<${local}-${runId}@${domain}>`;
    const subject = `E2E ${subjectMatch[1]!} ${runId}`;

    const stamped = raw.replace(idMatch[0], `Message-ID: ${messageId}`).replace(subjectMatch[0], `Subject: ${subject}`);

    return {
        bytes: Buffer.from(stamped, "binary"),
        messageId,
        subject,
        // What the ingest will write, for the single attachment in a one-PDF forward: part 1.
        externalRef: `${messageId}#1`
    };
}

export class Mailbox {
    private constructor() {}

    /** Start GreenMail on the stack's network and wait until it answers IMAP. */
    static async start(): Promise<Mailbox> {
        // `rm -f` first rather than trusting `--rm`: a run killed with SIGKILL leaves the container.
        docker("rm", "-f", MAILBOX_CONTAINER);
        docker(
            "run",
            "-d",
            "--rm",
            "--name",
            MAILBOX_CONTAINER,
            "--network",
            composeNetwork(),
            "-p",
            `${HOST}:${HOST_PORT}:${MAILBOX_CONTAINER_PORT}`,
            "-e",
            "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 " +
                `-Dgreenmail.users=${MAILBOX_USER}:${MAILBOX_PASSWORD}`,
            IMAGE
        );

        const mailbox = new Mailbox();
        const deadline = Date.now() + 60_000;
        for (;;) {
            try {
                await mailbox.session(async () => undefined);
                return mailbox;
            } catch (error) {
                if (Date.now() > deadline) {
                    throw error;
                }
                await sleep(500);
            }
        }
    }

    stop(): void {
        docker("rm", "-f", MAILBOX_CONTAINER);
    }

    /** One connection, closed afterwards — the same shape the Connector uses, for the same reason. */
    private async session<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
        const client = new ImapFlow({
            host: HOST,
            port: HOST_PORT,
            secure: false,
            auth: { user: MAILBOX_USER, pass: MAILBOX_PASSWORD },
            logger: false
        });
        await client.connect();
        try {
            return await work(client);
        } finally {
            await client.logout().catch(() => undefined);
        }
    }

    /**
     * Create the incoming folder, and only that one.
     *
     * The other three are the *ingest's* job — `ensureFolders` is its first step, and a missing
     * folder being created rather than throwing is a property the integration tier already pins. So
     * creating them here would hide it. This one has to exist because a message has to be delivered
     * into it.
     */
    async createIncomingFolder(): Promise<void> {
        await this.session(async (client) => {
            await client.mailboxCreate(MAILBOX_FOLDERS.incoming).catch(() => undefined);
        });
    }

    /** Real bytes over the wire, exactly as a delivering server would leave them. */
    async deliver(folder: string, bytes: Buffer): Promise<number> {
        return this.session(async (client) => {
            const result = await client.append(folder, bytes);
            if (!result || typeof result.uid !== "number") {
                throw new Error(`APPEND to ${folder} gave no UID`);
            }
            return result.uid;
        });
    }

    /** How many messages are sitting in a folder. `undefined` when the folder does not exist yet. */
    async count(folder: string): Promise<number | undefined> {
        return this.session(async (client) => {
            const boxes = await client.list();
            if (!boxes.some((box) => box.path === folder)) {
                return undefined;
            }
            const lock = await client.getMailboxLock(folder);
            try {
                const uids: number[] = [];
                for await (const message of client.fetch("1:*", { uid: true })) {
                    uids.push(message.uid);
                }
                return uids.length;
            } finally {
                lock.release();
            }
        });
    }
}
