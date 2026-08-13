/**
 * What a Conversation is about, as something the Header can link to — or nothing.
 *
 * The *or nothing* is the part that matters. `subjectModel` is a plain String field with no enumeration
 * and no writer-side constraint, and an activity descriptor matching no scene is silently invisible: it
 * renders nothing and reports nothing. So the module comes from a whitelist rather than from stripping
 * `_DM`, and a header that cannot offer a working link offers none.
 */

/** What `ActivityActions.create` wants: a module, a docRef and the Document Model that loads it. */
export interface SubjectDescriptor {
    readonly module: string;
    readonly instance: string;
    readonly model: string;
}

/**
 * The four `TRIGGER_ELIGIBLE_MODELS`, and the navigation modules of `AssistantsAppModel_AM` that show
 * them. These are the only Models a Conversation's subject can be, and the only ones with a module.
 */
const SUBJECT_MODULES: Readonly<Record<string, string>> = {
    Document_DM: "Document",
    Invoice_DM: "Invoice",
    Process_DM: "Process",
    Party_DM: "Party"
};

/** The subject Thing's own form, addressed the way the activity map wants it — or nothing. */
export function subjectDescriptor(
    subjectModel: string | undefined,
    subjectThingId: string | undefined
): SubjectDescriptor | undefined {
    const module = subjectModel === undefined ? undefined : SUBJECT_MODULES[subjectModel];
    if (module === undefined || subjectModel === undefined || !subjectThingId) {
        return undefined;
    }
    // A ThingID identifies and nothing more (ADR-0002), so the docRef is composed here rather than read.
    return { module, instance: `${subjectModel}/${subjectThingId}`, model: subjectModel };
}
