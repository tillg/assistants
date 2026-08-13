import type { FormModel, FormModelMap } from "@com.mgmtp.a12.formengine/formengine-core";
import { LoggerFactory } from "@com.mgmtp.a12.utils/utils-logging";

import { ConversationTranscript } from "./conversation/ConversationTranscript";
import { QuestionContext } from "./conversation/QuestionContext";
import { WIDGET_ANNOTATION_NAME, getAnnotationValue } from "./widgetAnnotation";

/**
 * `formModelMap.CustomScreenElement`: the platform's answer to *"the modeller reached the limit of
 * modelling; a developer puts something here"*.
 *
 * A `CustomScreenElement` has no `elementRef`, so which element a placeholder is gets decided by the
 * `widget` annotation — the same idiom the markdown editor already uses on `Control`. The document the
 * element renders is the one the form engine already holds, which is the whole reason this seam is
 * cheap: no new data flow for the document the form is already on.
 *
 * An unknown or absent value renders **nothing** and says so once. A modelled placeholder that no
 * developer has filled in is a gap in the model, not a reason for the form around it to fail to open.
 */

const logger = LoggerFactory.getLogger("PT/CustomScreenElements");

/** Once per widget value, because a placeholder rendered in a repeat would otherwise flood the console. */
const alreadyReported = new Set<string>();

export function CustomScreenElements({
    modelElement,
    config
}: FormModelMap.FormModelComponentProps<FormModel.CustomScreenElement>) {
    const widget = getAnnotationValue(modelElement.annotations, WIDGET_ANNOTATION_NAME);
    const document = config.renderOptions.state.data.document;

    switch (widget) {
        case "conversation-transcript":
            // One widget value, two forms. The Conversation form holds the thread itself; the Answer
            // Surface holds an Open Question that *names* one, and reading it is seam 4's other half.
            // Which it is, is a fact about the document, so nothing has to be modelled twice.
            //
            // The test is for an Open Question rather than against a Conversation on purpose: a document
            // the engine has not filled in yet is neither, and it belongs on the branch that shows an
            // empty thread, not on the one that reports a conversation it could not find.
            return isOpenQuestion(document) ? (
                <QuestionContext document={document} height={modelElement.height} />
            ) : (
                <ConversationTranscript document={document} height={modelElement.height} />
            );
        default:
            report(modelElement.id, widget);
            return null;
    }
}

/** A JSONDocument is keyed by its root group's name, which is the Document Model's own. */
function isOpenQuestion(document: unknown): boolean {
    const root = (document as { OpenQuestion?: unknown } | null | undefined)?.OpenQuestion;
    return typeof root === "object" && root !== null;
}

function report(id: string, widget: string | undefined): void {
    const key = widget ?? "";
    if (alreadyReported.has(key)) {
        return;
    }
    alreadyReported.add(key);
    logger.warn(
        `CustomScreenElement "${id}" carries no component: its "${WIDGET_ANNOTATION_NAME}" annotation is ` +
            `"${widget ?? "(absent)"}". Rendering nothing.`
    );
}
