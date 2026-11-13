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
