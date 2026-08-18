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

/**
 * A comma-separated list, trimmed, with blanks dropped.
 *
 * Unset and empty both mean the empty list rather than a default, because the one list read this way
 * grants access: a typo that produced a non-empty fallback would be a widening nobody wrote down.
 */
function list(name: string): readonly string[] {
    return (process.env[name] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
}

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

    /**
     * The file that names every LLM configuration and says which one is active — see
     * {@link loadLlmProfile}. The provider, its endpoint, its model and its temperature all come
     * from there rather than from five environment variables, because a second endpoint should be
     * a named entry one switch away and not a second set of exports.
     *
     * The path is cwd-relative, and the container's working directory is `/app`, where compose
     * mounts the project's own `llm.json`.
     */
    readonly llmConfigFile: string;

    readonly scanIntervalMs: number;
    readonly leaseSeconds: number;
    readonly maxBirthsPerHour: number;
    readonly maxEscalations: number;
    readonly llmMaxAttempts: number;
    readonly uiBaseUrl: string;
    /**
     * The timezone every Schedule Trigger's `cron` is read in (ADR-0016).
     *
     * A household means local time by "every Monday at nine", and one setting for the whole system
     * rather than one per Assistant: a household lives in one place, and a per-Assistant timezone
     * would be a field nobody sets correctly and everybody has to reason about.
     */
    readonly scheduleTimezone: string;

    /**
     * The port the inbox listens on, or `0` for "do not listen at all" (ADR-0023).
     *
     * Zero is the default because the Runtime's job is the scan loop and the inbox is an addition to
     * it: a deployment that does not want the door open should not have to know a setting exists to
     * keep it shut. Compose sets it; a test binds an ephemeral port; nothing else opens a socket.
     */
    readonly inboundPort: number;
    /**
     * The secret the server presents to the inbox. Not the User's authentication — that already
     * happened at the server, against Keycloak — this is what stops any other container on the
     * compose network calling the door outward.
     */
    readonly inboundSecret: string;
    /**
     * The Operations an External Call may name. Deployment's half of the gate, and deliberately
     * separate from `clientReadable`: that flag says an Operation is *safe* to call without a
     * Conversation, and this list says we have decided to *offer* it. Empty means the inbox admits
     * nothing, which is the right default for a list that grants access.
     */
    readonly clientCallable: readonly string[];

    /**
     * The letterbox. Grouped rather than flattened into ten more fields on `Config`, because the
     * mail ingest takes the whole of it as one argument and nothing else in the process wants any
     * part of it — the grouping is what the code actually passes around.
     */
    readonly mail: MailConfig;

    /**
     * Reading a scan costs money per page, so both caps live here rather than in the reader.
     *
     * Which *model* does the reading is not here: that is `llm.json`'s `vision` profile, for the
     * same reason the active model is not an environment variable — a second endpoint should be a
     * named entry one switch away, not a second set of exports.
     */
    readonly visionMaxPages: number;
    readonly visionMaxBytes: number;
}

export interface MailConfig {
    /** Empty means the scan never runs. The default, and not an error. */
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    /**
     * Implicit TLS, which is what port 993 means and what every provider wants. Optional here for
     * the same reason it is optional on `MailboxOptions`: absent means `true`, so the safe answer
     * is the one you get by saying nothing.
     *
     * `MAIL_SECURE=false` is the one escape hatch, and it buys **plaintext** — not TLS with the
     * certificate unchecked. There is deliberately no setting for that second thing. A mail server
     * on a private network is a real configuration (a container inside this stack's own compose
     * network, a Dovecot on localhost), and plaintext to it is visible in `.env`, named in the
     * startup log and greppable; a TLS session that has quietly stopped verifying is none of those.
     */
    readonly secure?: boolean;
    /** The only folder the ingest reads. A Gmail label, seen through IMAP as a folder. */
    readonly folderIncoming: string;
    readonly folderProcessed: string;
    readonly folderFailed: string;
    readonly folderRejected: string;
    /**
     * Who may post to the letterbox. **Empty means nobody**, which is why it is read with
     * {@link list} and given no fallback.
     *
     * A mailbox is the first untrusted input this system has: every other way a Thing comes into
     * being involves the User typing. A default that failed open on a public address would turn
     * spam into Conversations and LLM spend on the first day it was misconfigured.
     */
    readonly allowedSenders: readonly string[];
    readonly pollIntervalMs: number;
    readonly maxPerPoll: number;
    readonly maxAttachmentBytes: number;

    /**
     * Which wire the letterbox is read over. Everything above this field is shared by both: the
     * four folders, the allowlist, the poll interval and the caps are decisions about the
     * *household*, not about a protocol, and duplicating them per transport would be four more
     * places for the allowlist to disagree with itself.
     *
     * Optional for the same reason `secure` is: absent means the transport that was here before
     * this one existed, so a `MailConfig` built by hand — a test, the end-to-end tier's throwaway
     * IMAP server — keeps working without knowing a choice was added. `loadConfig` always sets it.
     */
    readonly transport?: MailTransport;
    /**
     * The Gmail API's half of the credentials, empty unless `MAIL_TRANSPORT=gmail`.
     *
     * A refresh-token grant, not a password: Gmail's IMAP needs the `https://mail.google.com/`
     * scope and therefore an App Password and 2FA on the account, which this household does not
     * have. It does have a completed OAuth consent — the sibling `wikai` project already uses it —
     * so these four values already exist and no new setup is asked of anybody. See `.env.example`
     * for the two commands that print them.
     */
    readonly gmail?: GmailCredentials;
}

/** IMAP by default; `gmail` when a refresh token says the OAuth grant is the way in. */
export type MailTransport = "imap" | "gmail";

export interface GmailCredentials {
    /** The mailbox. Empty means the API's `me` — the account the grant belongs to. */
    readonly user: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
}

/**
 * What `MAIL_HOST` holds when the transport is Gmail.
 *
 * The mail ingest reads an empty `host` as "the household has no letterbox" and returns without
 * opening anything — the correct default, and the one thing standing between a Gmail-only
 * deployment and a scan that never runs, because there is no IMAP host to name. So a configured
 * Gmail transport fills it with the transport's own name, which is also what
 * the Connector records in `MessageOrigin.host` for every message it produces: one word, true in both places.
 */
const GMAIL_HOST = "gmail";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    void env;
    // Read before the object literal because `inboundSecret` is conditional on it: the secret is
    // required exactly when the door is open, and optional when it is not.
    const inboundPort = number("INBOUND_PORT", 0);

    // Read before the mail block for the same reason: `MAIL_HOST` depends on it. The default is
    // whichever transport the environment has actually been given credentials for — a household
    // that pastes a refresh token in has said what it means, and should not also have to learn
    // that a switch exists. Anything other than the exact word `gmail` is IMAP, so a typo falls
    // back to the transport that was there before rather than to a half-configured new one.
    const gmail: GmailCredentials = {
        user: optional("GMAIL_USER", ""),
        clientId: optional("GMAIL_CLIENT_ID", ""),
        clientSecret: optional("GMAIL_CLIENT_SECRET", ""),
        refreshToken: optional("GMAIL_REFRESH_TOKEN", ""),
    };
    const transport: MailTransport =
        optional("MAIL_TRANSPORT", gmail.refreshToken === "" ? "imap" : "gmail") === "gmail"
            ? "gmail"
            : "imap";
    // Only a transport that could actually run gets to fill the host in. `MAIL_TRANSPORT=gmail`
    // with no refresh token is a half-finished edit, and it must leave the letterbox switched off
    // rather than start a poll that fails at its first call every minute.
    const gmailReady = transport === "gmail" && gmail.refreshToken !== "";

    return {
        thingStoreUrl: optional("THINGSTORE_URL", "http://server:8080"),
        thingStoreUser: optional("THINGSTORE_USER", "runtime"),
        // No default, on purpose. `.env` is the only place this value lives (D-023) — the same
        // variable reaches the container through compose and the host recipes through the
        // justfile. A literal here would be a third copy, correct only until someone changes the
        // first one, and then the Runtime would authenticate with the old value and fail at its
        // first authenticated call instead of at startup.
        thingStorePassword: required("THINGSTORE_PASSWORD"),
        bootstrapUser: optional("BOOTSTRAP_USER", "human"),
        bootstrapPassword: optional("BOOTSTRAP_PASSWORD", "human"),
        locale: optional("LOCALE", "en"),

        keycloakUrl: optional("KEYCLOAK_URL", "http://keycloak:8080"),
        keycloakRealm: optional("KEYCLOAK_REALM", "A12Realm"),
        keycloakClientId: optional("KEYCLOAK_CLIENT_ID", "assistants-runtime-client"),

        fireflyUrl: optional("FIREFLY_URL", "http://firefly:8080"),
        fireflyTokenFile: optional("FIREFLY_TOKEN_FILE", "/run/firefly/pat.txt"),
        fireflyToken: optional("FIREFLY_TOKEN", ""),

        llmConfigFile: optional("LLM_CONFIG_FILE", "llm.json"),

        scanIntervalMs: number("SCAN_INTERVAL_MS", 2000),
        leaseSeconds: number("LEASE_SECONDS", 120),
        maxBirthsPerHour: number("MAX_BIRTHS_PER_HOUR", 200),
        maxEscalations: number("MAX_ESCALATIONS", 3),
        llmMaxAttempts: number("LLM_MAX_ATTEMPTS", 3),
        uiBaseUrl: optional("UI_BASE_URL", "http://localhost:8081"),
        // The household this system was written for is in Germany — every model is bilingual and the
        // invoices are GOÄ. UTC would have been the neutral choice and would have put the
        // daylight-saving cases ADR-0016 exists for out of reach in practice.
        scheduleTimezone: optional("SCHEDULE_TIMEZONE", "Europe/Berlin"),

        inboundPort,
        // `required`, and only when the port is open: a listener that would execute Operations for
        // anyone who can reach it is not something to start with an empty default. Failing at
        // startup is the correct behaviour — the alternative is a door that opens quietly.
        inboundSecret: inboundPort === 0 ? "" : required("INBOUND_SECRET"),
        clientCallable: list("CLIENT_CALLABLE_OPERATIONS"),

        mail: {
            // No sentinel. The ingest asks the transport whether there is a letterbox, so a Gmail
            // deployment leaves this empty and nothing minds — it used to be filled with the literal
            // "gmail" purely to satisfy a guard that was asking the wrong question.
            host: optional("MAIL_HOST", ""),
            port: number("MAIL_PORT", 993),
            user: optional("MAIL_USER", ""),
            password: optional("MAIL_PASSWORD", ""),
            // Exactly the word `false` switches it off. A typo — `no`, `0`, `False` — leaves TLS on,
            // because the failure mode of guessing wrong here is a password crossing a network in
            // the clear.
            secure: optional("MAIL_SECURE", "true") !== "false",
            // Gmail nests labels with `/`, and the household's label is `assistants`, after the system itself. These are
            // configuration rather than constants because the same ingest should work against a
            // provider that spells its folders differently.
            folderIncoming: optional("MAIL_FOLDER_INCOMING", "assistants"),
            folderProcessed: optional("MAIL_FOLDER_PROCESSED", "assistants/processed"),
            folderFailed: optional("MAIL_FOLDER_FAILED", "assistants/failed"),
            folderRejected: optional("MAIL_FOLDER_REJECTED", "assistants/rejected"),
            allowedSenders: list("MAIL_ALLOWED_SENDERS").map((entry) => entry.toLowerCase()),
            // A minute. `SCAN_INTERVAL_MS` is two seconds, and an IMAP login every two seconds is
            // abusive enough that several providers rate-limit or lock the account for it.
            pollIntervalMs: number("MAIL_POLL_INTERVAL_MS", 60_000),
            maxPerPoll: number("MAIL_MAX_PER_POLL", 20),
            maxAttachmentBytes: number("MAIL_MAX_ATTACHMENT_BYTES", 25 * 1024 * 1024),
            transport,
            gmail,
        },

        // Ten pages is generous for a household invoice and mean for a pension provider's annual
        // brochure, which is the distinction worth drawing: over the cap it reports a reason, and
        // never a truncated read. A partial invoice is worse than no invoice, because it looks
        // complete.
        visionMaxPages: number("VISION_MAX_PAGES", 10),
        visionMaxBytes: number("VISION_MAX_BYTES", 16 * 1024 * 1024),
    };
}

export { required };
