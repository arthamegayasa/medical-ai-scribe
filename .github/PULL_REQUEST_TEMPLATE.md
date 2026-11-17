## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Closes #123". -->

## How it was tested

<!-- Tests added or updated, and what you checked by hand. Include before/after screenshots for UI changes (fictional content only). -->

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:e2e` (UI changes, once available)

## Checklist

- [ ] Behaviour changes come with a test that failed before the change.
- [ ] No runtime dependencies, devDependencies or build step added.
- [ ] Works under the CSP in `vercel.json`: no inline scripts, styles or handlers, no third-party assets, CSP not widened.
- [ ] Keys and clinical content are not written to URLs, logs, errors or exports, and go only to the chosen provider.
- [ ] The draft label, review flags, unverified and check-number markers stay visible in the UI and exports.
- [ ] New UI text is in both `en.js` and `id.js`.
- [ ] New provider presets: CORS preflight verified and recorded in `providers.js`.
- [ ] Documentation updated where behaviour, configuration or providers changed.
- [ ] No real patient data, recordings, keys or tokens anywhere in this pull request.
