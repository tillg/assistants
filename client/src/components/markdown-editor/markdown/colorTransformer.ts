import { type TextMatchTransformer } from "@lexical/markdown";
import { $createTextNode, $isTextNode } from "lexical";

import { $isInlineStyleTextNode } from "@com.mgmtp.a12.widgets/widgets-core";

import { isValidColor } from "../../color-picker/colors";

import { serializeDirectiveAttributes } from "./directives";

// Hex / CSS-name validation now lives in the shared colour module; re-exported so the `:color`
// directive's importers (the colour dialog) keep their path.
export { isValidColor, isValidHexColor } from "../../color-picker/colors";

// The directive's text and value are captured permissively (`[^\]]*` / `[^"]+`)
// and the value is validated in `replace` — an invalid value (non-hex, non-name)
// leaves the run as plain text (spec 009 degrade-for-free), so the value space
// need not be baked into the regex. The `:color[` start is name-specific, so
// prose like `16:00` is never mis-parsed.
const COLOR_DIRECTIVE = /:color\[([^\]]*)\]\{value="([^"]+)"\}/;
const COLOR_DIRECTIVE_AT_END = /:color\[([^\]]*)\]\{value="([^"]+)"\}$/;

/**
 * The color of a text run, read from its inline `style` (`color: …`), or null when
 * the run carries no color or a color the directive can't represent (`rgb()`, a
 * theme token — not a hex or CSS name).
 */
export function extractColor(style: string): string | null {
    const value = /(?:^|;)\s*color:\s*([^;]+)/i.exec(style)?.[1]?.trim();
    if (value === undefined) {
        return null;
    }
    return isValidColor(value) ? value : null;
}

/**
 * Inline text-color directive `:color[<text>]{value="<color>"}` (spec 009) — the
 * editor's first text (inline) directive. Colored text is stored as inline CSS
 * `style="color:…"` on the text run (applied via $patchStyleText); this
 * `TextMatchTransformer` (de)serializes that to/from markdown, reusing the shared
 * `{key="value"}` attribute serializer for the emitted form.
 *
 * `<color>` is a hex (`#RGB` / `#RRGGBB`) or a standard CSS color name (stored
 * lowercased). Color **composes** with the standard inline marks: on export the
 * run's format is written inside the brackets (a bold+colored run → `:color[**x**]`)
 * via the `exportFormat` helper; on import the created colored node is returned so
 * Lexical re-applies the inner `**`/`_`/`~~` markers to it — the node is reused
 * when the format spans the whole content, so the color style is preserved. A value
 * that is neither hex nor a CSS name matches the regex but is rejected in `replace`,
 * leaving the text verbatim (degrade-for-free).
 */
export const COLOR: TextMatchTransformer = {
    dependencies: [],
    export: (node, _exportChildren, exportFormat) => {
        if (!$isTextNode(node)) {
            return null;
        }
        const color = extractColor(node.getStyle());
        if (color === null) {
            return null;
        }
        const attrs = serializeDirectiveAttributes([["value", color]]);
        return `:color[${exportFormat(node, node.getTextContent())}]{${attrs}}`;
    },
    importRegExp: COLOR_DIRECTIVE,
    regExp: COLOR_DIRECTIVE_AT_END,
    replace: (textNode, match) => {
        const [, text, rawColor] = match;
        if (text === undefined || rawColor === undefined) {
            return;
        }
        const color = rawColor.trim().toLowerCase();
        if (!isValidColor(color)) {
            // Not a color we can represent — leave the matched text as plain text.
            return;
        }
        const colored = $createTextNode(text).setStyle(`color: ${color};`);
        // TODO: remove when A12-19022 is fixed
        if ($isInlineStyleTextNode(colored)) {
            colored.setUnmergeable();
        }
        textNode.replace(colored);
        // Returning the node lets Lexical apply inner format markers (bold/italic/…)
        // to it while preserving the color style — enables `:color[**text**]`.
        return colored;
    },
    trigger: "}",
    type: "text-match"
};
