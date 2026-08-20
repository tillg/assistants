// bookkeeping.postTransaction — book a balanced transaction. Safe to retry, three ways:
//   1. external_id is the Turn's idempotency key, so a repeat of the same Turn is recognised;
//   2. the thing: tag catches the same posting booked under a *different* key (two Turns, or two
//      Conversations, about one invoice each mint their own key — external_id cannot see those,
//      because it participates in Firefly's duplicate hash, so the differing key defeats that guard);
//   3. Firefly's own error_if_duplicate_hash catches an identical posting, and a corrected journal
//      (one the User deleted) is re-bookable because we retry without the flag once the victim is gone.
// The User must approve the exact posting first — the Runtime enforces that before execute is reached.

// Has a transaction already been booked under this key? The value must be quoted inside Firefly's
// search grammar (external_id_is:"...") or the colon in the key splits it and it matches nothing.
async function findByExternalId(host, externalId) {
    const body = await fireflyCall(host, "GET", "/api/v1/search/transactions", {
        query: { query: 'external_id_is:"' + externalId + '"', limit: 5 },
    });
    const first = body && body.data ? body.data[0] : undefined;
    return first ? { id: first.id } : undefined;
}

// Two postings are the same when their money, date, type and both account ids agree.
function sameSplit(wanted, booked) {
    const amount = (value) => Number(Number(value === undefined || value === null ? NaN : value).toFixed(2));
    return (
        String(booked.date || "").slice(0, 10) === String(wanted.date || "").slice(0, 10) &&
        amount(booked.amount) === amount(wanted.amount) &&
        Number.isFinite(amount(wanted.amount)) &&
        String(booked.type || "") === String(wanted.type || "") &&
        String(booked.source_id || "") === String(wanted.source_id || "") &&
        String(booked.destination_id || "") === String(wanted.destination_id || "")
    );
}

// Is this exact posting already booked against this Thing, under any key? Compared on the content,
// not the tag alone: one invoice may have up to four legitimate journals (book the payable, pay it,
// claim from the insurer, the insurer pays), all carrying the same ThingID, so matching on the tag
// alone would make the payment leg a silent no-op — a worse bug than the one this fixes.
async function findSamePostingForThing(host, thingId, wanted) {
    const body = await fireflyCall(host, "GET", "/api/v1/search/transactions", {
        query: { query: 'tag_is:"thing:' + thingId + '"', limit: 25 },
    });
    for (const group of (body && body.data) || []) {
        const booked = (group.attributes && group.attributes.transactions) || [];
        if (booked.length !== wanted.length) continue;
        const allMatched = wanted.every(function (split) {
            return booked.some(function (candidate) {
                return sameSplit(split, candidate);
            });
        });
        if (allMatched) return group.id;
    }
    return undefined;
}

// The transaction Firefly says this one duplicates, if a 422 said so. The message
// "Duplicate of transaction #14." arrives under a per-split key, so it is matched across all of them.
function duplicateHashVictim(status, body) {
    if (status !== 422) return undefined;
    const errors = (body && body.errors) || {};
    for (const key of Object.keys(errors)) {
        for (const message of errors[key]) {
            const match = /Duplicate of transaction #(\d+)/i.exec(message);
            if (match) return match[1];
        }
    }
    const match = /Duplicate of transaction #(\d+)/i.exec(String((body && body.message) || ""));
    return match ? match[1] : undefined;
}

// Does that journal still exist? Firefly answers a missing one with 401, not 404 — measured. A
// non-2xx that is neither is read as "still there" (conservative: do not re-book over it).
async function transactionExists(host, id) {
    const response = await host.http.request({ method: "GET", path: "/api/v1/transactions/" + id });
    return response.ok || (response.status !== 401 && response.status !== 404);
}

async function execute(args, host) {
    const splits = Array.isArray(args.splits) ? args.splits : [];
    if (splits.length === 0) host.error("postTransaction needs at least one split.");
    const externalId = host.context.idempotencyKey;

    // If this key already landed, this is a retry — return it rather than book a second time.
    const already = await findByExternalId(host, externalId);
    if (already) return { transactionId: already.id, alreadyExisted: true };

    const transactions = [];
    for (const split of splits) {
        const sourceId = await resolveAccountId(host, String(split.sourceAccount || ""));
        const destinationId = await resolveAccountId(host, String(split.destinationAccount || ""));

        if (split.currencyCode) {
            const accountCurrency = await currencyOf(host, String(split.sourceAccount || ""));
            if (accountCurrency && String(split.currencyCode).toUpperCase() !== String(accountCurrency).toUpperCase()) {
                host.error(
                    '"' +
                        split.sourceAccount +
                        '" keeps its books in ' +
                        accountCurrency +
                        ", and this posting is in " +
                        split.currencyCode +
                        ". Firefly would silently store it as " +
                        accountCurrency +
                        " at the same number, so it is refused. Convert the amount to " +
                        accountCurrency +
                        " first, or ask the User which rate to use.",
                );
            }
        }

        const row = {
            type: split.type,
            date: split.date,
            amount: split.amount,
            description: split.description,
            currency_code: split.currencyCode || "EUR",
            source_id: sourceId,
            destination_id: destinationId,
            external_id: externalId,
        };
        if (split.budgetName) row.budget_name = split.budgetName;
        // Category is resolved to an id, never posted by name, so a typo cannot auto-create one.
        if (split.categoryName) row.category_id = await resolveCategoryId(host, String(split.categoryName));
        if (split.notes) row.notes = split.notes;
        // Link the journal back to the Invoice Thing — for a human in Firefly, and for the dedup below.
        if (args.thingId) row.tags = ["thing:" + args.thingId];
        transactions.push(row);
    }

    // The same posting may already be booked under a different key. external_id cannot see it; the
    // thing: tag can. Content-compared, so a genuine second leg of the same invoice still books.
    if (args.thingId) {
        const alreadyForThing = await findSamePostingForThing(host, args.thingId, transactions);
        if (alreadyForThing) return { transactionId: alreadyForThing, alreadyExisted: true };
    }

    const body = { transactions: transactions };
    if (args.groupTitle) body.group_title = args.groupTitle;

    const response = await host.http.request({
        method: "POST",
        path: "/api/v1/transactions",
        body: Object.assign({}, body, { error_if_duplicate_hash: true }),
    });
    if (response.ok) return { transactionId: response.body.data.id, alreadyExisted: false };

    // Firefly's duplicate-hash index outlives a delete while its search does not, so a journal the
    // User removed as a correction would block its own key for ever. Retry without the flag — but
    // ONLY once the named journal is confirmed gone, or this would re-open the double-booking hole.
    const victim = duplicateHashVictim(response.status, response.body || {});
    if (victim !== undefined && !(await transactionExists(host, victim))) {
        const retry = await host.http.request({
            method: "POST",
            path: "/api/v1/transactions",
            body: Object.assign({}, body, { error_if_duplicate_hash: false }),
        });
        if (retry.ok) return { transactionId: retry.body.data.id, alreadyExisted: false };
        const retryDetails = retry.body || {};
        host.error(describeRejection(retryDetails, splits) || retryDetails.message || "Firefly HTTP " + retry.status);
    }

    const details = response.body || {};
    host.error(describeRejection(details, splits) || details.message || "Firefly HTTP " + response.status);
}

async function reconcile(args, host) {
    const landed = await findByExternalId(host, host.context.idempotencyKey);
    if (landed) return { transactionId: landed.id, alreadyExisted: true };
    host.error(
        "This booking was interrupted before it reached the books, so nothing was posted. Book it again if it is still right.",
    );
}
