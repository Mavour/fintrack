# Background DOM update regression

After `npm run build`, compile `src/web/lib/patchContent.ts` with TypeScript
(`--target ES2022 --module ES2022 --lib ES2022,DOM,DOM.Iterable --skipLibCheck`)
into `dist/public/__regression/`. Copy `patchContent.mjs` from this directory
there as `check.mjs`, and add an `index.html` containing:

```html
<!doctype html><html><head><title>DOM update regression</title></head>
<body><script type="module" src="./check.mjs"></script></body></html>
```

Open `/__regression/index.html` on the local server. All ten checks must pass;
the body receives `data-result="passed"`. The test uses synthetic DOM data and
does not call portfolio APIs. The next production build removes this harness.

## Home updates

Compile `src/web/pages/home.ts` with the same compiler options plus
`--rootDir src/web --moduleResolution bundler` into `dist/public/__home-regression/`.
Copy `homeUpdates.mjs` there as `check.mjs` and use the same HTML wrapper.
Open `/__home-regression/index.html`. All eight checks must pass. This harness
stubs its own fetch calls with synthetic balances and verifies that background
sync changes values without inserting/removing nodes or fetching charts again.
