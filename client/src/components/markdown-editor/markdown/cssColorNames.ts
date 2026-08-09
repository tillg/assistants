// The CSS colour name set now lives in the shared colour module (also used by the tag colour picker);
// re-exported here so the `:color` directive's importers keep their path. The `:color` directive
// (spec 009) degrades a non-colour value to plain text — which lets the Jira importer pass
// `{color:red}` through verbatim (spec 025).
export { CSS_COLOR_NAMES } from "../../color-picker/colors";
