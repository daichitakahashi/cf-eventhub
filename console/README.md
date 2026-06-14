```
npm install
npm run dev
```

This package is distributed as TypeScript source (`src/*.ts`) and does not
require a build step.

By default, this console targets the Durable Object named `default` via the
`EVENT_HUB` binding.
Adjust `wrangler.jsonc` (`durable_objects.bindings[].class_name` and
`script_name`) to match your EventHub worker.

```
npm run deploy
```
