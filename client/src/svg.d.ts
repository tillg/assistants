/**
 * SVG imports resolve to a URL string (webpack `type: "asset"`, see webpack.common.js).
 * Declared here because the project imports brand assets from `assets/logo/` as image URLs.
 */
declare module "*.svg" {
    const url: string;
    export default url;
}
