# Code Review

## 2026-08-21 — Branding: shared lockup in the application frame header, shared favicon

**Scope:** uncommitted working-tree changes on `main` —
`client/src/app/LayoutProvider.tsx`, `client/webpack.common.js`,
`client/src/components/conversation/useThingById.ts`, three test files (import order),
new `client/.gitignore` and `client/src/svg.d.ts`, deleted
`client/resources/html/images/favicon.svg`.

**A12 conformance verified against:** A12 release line **2026.06** (`gradle.properties:
a12ReleaseLine=2026.06`; docs queried at `2026.06-ext0`), `@com.mgmtp.a12.client/client-core`
17.0.0, `@com.mgmtp.a12.widgets/widgets-core` 39.0.2. Primary sources: dev tutorial
"Task 1 - Application Frame" (`overall/dev_tutorial_frontend_application_frame`), A12 Client
documentation bundle ("Elements of the Application Frame"), and the
`ApplicationFrameLayoutProps` type declarations shipped in `client-core` 17.0.0.

### Verdict

The change follows the A12-documented customization path. No blocking findings; two
advisories worth acting on before a dark theme lands.

### A12 conformance — what was checked and passed

1. **Logo via the `logo` prop of `FrameViews.ApplicationFrameLayout`**
   (`client/src/app/LayoutProvider.tsx:62`) is exactly the mechanism the A12 dev tutorial
   prescribes ("set the property `logo` in the `ApplicationFrameLayout` to a React component
   containing the logo"). The tutorial's own reference implementation is an inline
   `<img style={{ height: 40 }} src=... alt=... />`, so the inline `height: "2rem"` sizing here
   is consistent with documented A12 practice, not an ad-hoc deviation. The alternative
   `logoURL` prop (plain URL string) exists but gives no control over `alt`/sizing; the
   `logo` ReactNode prop is the better of the two documented options for a lockup.
2. **`title={<></>}`** is type-legal — `ApplicationFrameLayoutProps.title?: ReactNode`
   ("A custom component to be used for the title"). Suppressing the text title because the
   lockup already carries the wordmark is a reasonable use of the documented prop; the
   product name stays in the accessibility tree via the `<img alt="Assistants">` and the
   SVG's own `role="img" aria-label="Assistants"`. Same pattern the project's Keycloak theme
   documents for its visually-hidden headline.
3. **Custom layout registration** is untouched and remains the template-standard
   `addLayout("ApplicationFrame", { component: CustomApplicationFrameLayout })` path.
4. **Keycloak parity claim** in the comment at `LayoutProvider.tsx:39` is true:
   `compose/keycloak/themes/assistants/login/resources/img/lockup.svg` is byte-identical to
   `assets/logo/lockup-light.svg`.
5. **Plasma header logo size:** no hard pixel spec surfaced in the 2026.06 Plasma/Client docs;
   2rem (32px) is within the range the tutorial itself uses (40px) and above the asset
   README's 96px-wide lockup minimum at typical header widths.

### Advisories

1. **Hardcoded light lockup vs. future dark theme** (`LayoutProvider.tsx:41`).
   `lockup-light.svg` has fixed near-black ink (`#171A18`). Today this is safe: no custom
   themes exist (`client/src/themes/themes.generated.ts` is empty), so only the widgets Base
   theme is active and `ThemeChooser` renders `null`. But the repo ships `lockup-dark.svg`,
   and the asset README's own guidance for JSX embedding is `mark.svg` (ink = `currentColor`).
   The moment a dark theme is added to `client/src/themes/`, the header logo goes near-invisible
   with no compile-time signal. Suggest either switching on the active theme
   (`useThemeContext`) or a `currentColor`-based lockup variant when dark theming arrives.
2. **Keycloak lockup is a copy, not a reference.** The webpack favicon change achieves
   "single source of truth" for the browser tab, but the Keycloak theme necessarily keeps its
   own copy of the lockup (Keycloak themes can't reach into `assets/`). If the brand asset
   changes, `compose/keycloak/themes/assistants/login/resources/img/lockup.svg` must be
   re-copied by hand. A sync check (CI `cmp`) or a build-time copy step would remove the
   drift risk.

### Non-A12 findings

1. **`webpack.common.js:102`** — `favicon: Path.join(__dirname, "../assets/logo/favicon.svg")`
   resolves correctly (asset exists; HtmlWebpackPlugin accepts absolute paths outside the
   webpack `context`). The removed `globOptions.ignore` for the deleted client-local favicon
   is consistent — nothing else references `resources/html/images/favicon.svg` (grep over
   `client/resources` and `client/src` is clean). The PNG fallback favicons
   (`favicon-16/32/48.png`) remain unwired, same as before the change — the SVG favicon
   handles light/dark via `prefers-color-scheme` per the asset README, so this is acceptable.
2. **`client/src/svg.d.ts`** — correct ambient declaration for webpack `type: "asset"` SVG
   imports; sits inside the tsconfig `include` (`./src/**/*`), and because the `.svg` file
   resolves through this wildcard module (not as a program file), the import from outside
   `rootDir: ./src` is not a compiler error. Note: the declaration types *all* SVG imports as
   URL strings; if anyone later adds an SVGR-style component import, this file must change.
3. **`useThingById.ts:89`** — braces added around the early return; behavior identical
   (eslint `curly` compliance). Fine.
4. **Test files** — pure import reordering to satisfy the import-grouping lint rule; no
   behavioral change.
5. **`client/.gitignore` (`tmp/`)** — correct; keeps browser-test artifacts and logs out of
   the repo.
6. **`alt="Assistants"` is not localized** — deliberate and acceptable: it is the product
   name (the wordmark itself is untranslatable outlined type), and the A12 tutorial's own
   logo example also uses a hardcoded `alt`.

### Mechanical verification

- `npm run compile` (tsc + eslint + prettier check): **clean**, exit code 0.
- `npm test` (vitest): **67 test files, 618 tests, all passed** (81s).
