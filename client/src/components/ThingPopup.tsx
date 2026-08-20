import { createContext, useContext, useState, type PropsWithChildren } from "react";
import styled from "styled-components";

import { ModalOverlay } from "@com.mgmtp.a12.widgets/widgets-core";

import { modelLabel, shortId, thingLabel } from "./conversation/thingLabel";
import { useThingById } from "./conversation/useThingById";

/**
 * Reading a Thing *in place* — the second verb this change introduces. Until now opening a Thing meant
 * navigation (`openForeignForm`: tear down the region, push a master, push the detail), which costs the
 * reader their place in the list. This answers *"what is this?"* over the current screen and returns them
 * to exactly where they were.
 *
 * It shows a **read-only summary**, not the Thing's full modelled form. Mounting a foreign A12 FormEngine
 * in an overlay proved to fight the region: the activity that loads a form's models is a region activity,
 * so the region renders it too (a second, conflicting copy) — the framework's own answer to "a form in a
 * modal" is a *modelled* modal region, which is a larger, separate piece of work. A summary read straight
 * off the document `useThingById` already returns needs none of that, and still answers the question the
 * popup exists for: the Thing's identity (title + Model) and its data, at a glance, read-only.
 *
 * Read-only is inherent here — the summary is text, there is nothing to edit — which is exactly the
 * invariant `useThingById` keeps: reads may cross documents, writes may not.
 *
 * One host, mounted once near the app root, holds the single (model, thingId) on show; `useThingPopup()`
 * is the setter any `ThingLink` calls. A popup opened from inside a popup is not a case this needs, so a
 * second open simply replaces the first.
 */

interface OpenThing {
    readonly model: string;
    readonly thingId: string;
}

type OpenPopup = (model: string, thingId: string) => void;

const ThingPopupContext = createContext<OpenPopup | undefined>(undefined);

/** The setter a `ThingLink` calls to open a Thing in the popup. Throws if no host is mounted above it. */
export function useThingPopup(): OpenPopup {
    const open = useContext(ThingPopupContext);
    if (open === undefined) {
        throw new Error("useThingPopup must be used within a ThingPopupHost");
    }
    return open;
}

export function ThingPopupHost({ children }: PropsWithChildren) {
    const [shown, setShown] = useState<OpenThing | undefined>(undefined);

    const open: OpenPopup = (model, thingId) => setShown({ model, thingId });
    const close = () => setShown(undefined);

    return (
        <ThingPopupContext.Provider value={open}>
            {children}
            {shown !== undefined && (
                <ModalOverlay closeOnEsc closeOnOutsideClick focusOnOpen maxWidth={720} onClose={close}>
                    <ThingSummary model={shown.model} thingId={shown.thingId} />
                </ModalOverlay>
            )}
        </ThingPopupContext.Provider>
    );
}

const Panel = styled.div`
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.25rem;
    color: ${({ theme }) => theme.colors.text.color};
`;

const Heading = styled.h2`
    margin: 0;
    font-size: ${({ theme }) => theme.typography.fontSize.lgFontSize};
    color: ${({ theme }) => theme.colors.text.color};
`;

const Note = styled.p`
    margin: 0;
    color: ${({ theme }) => theme.colors.text.secondaryColorDark};
`;

const Fields = styled.dl`
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 1rem;
    margin: 0;

    dt {
        font-weight: 600;
        color: ${({ theme }) => theme.colors.text.secondaryColorDark};
    }

    dd {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        color: ${({ theme }) => theme.colors.text.color};
    }
`;

/**
 * The Thing, read-only: its Thing Label as a heading, then its own scalar fields as rows. Fails soft the
 * way every read on these screens does — a Thing that will not load says so, and never blanks or throws.
 */
function ThingSummary({ model, thingId }: { readonly model: string; readonly thingId: string }) {
    const read = useThingById(model, thingId);
    const name = modelLabel(model);
    const label = read.state === "ready" ? thingLabel(model, read.document, thingId) : shortId(thingId);

    return (
        <Panel data-role="thing-summary">
            <Heading data-role="thing-summary-title">{name !== undefined ? `${label} (${name})` : label}</Heading>
            {read.state === "loading" && <Note>Loading…</Note>}
            {read.state === "nothing" && <Note>This {name ?? "Thing"} could not be read.</Note>}
            {read.state === "ready" && <SummaryFields document={read.document} model={model} />}
        </Panel>
    );
}

/** The Thing's own scalar fields (string / number / boolean), by name — the complex ones (Entries, Skills, …) are left out. */
function SummaryFields({ document, model }: { readonly document: object; readonly model: string }) {
    const fields = asRecord(asRecord(document)[model.replace(/_DM$/, "")]) ?? {};
    const rows = Object.entries(fields).filter(([, value]) => isScalar(value) && value !== "");

    if (rows.length === 0) {
        return <Note>No further detail to show.</Note>;
    }

    return (
        <Fields>
            {rows.map(([key, value]) => (
                <div key={key} style={{ display: "contents" }}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                </div>
            ))}
        </Fields>
    );
}

function isScalar(value: unknown): value is string | number | boolean {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
