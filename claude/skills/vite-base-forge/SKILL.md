---
name: vite-base-forge
description: Use when configuring Vite for a Forge Custom UI module. Forge serves UI assets from a non-root path so Vite MUST set base './' in vite.config.js or the resulting bundle will white-screen on the user's instance with broken asset URLs.
user-invocable: false
---

# Vite Base Path for Forge Custom UI

## The rule

Every Forge Custom UI module that builds with Vite MUST have `base: './'` in its `vite.config.js` (or `vite.config.ts`). No exception.

```js
// vite.config.js - REQUIRED for Forge Custom UI
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',          // <- this line
  plugins: [react()],
  build: {
    outDir: 'build',   // or whatever Forge expects per module
  },
});
```

## Why

Forge serves Custom UI assets from a path determined by Atlassian at runtime. Without `base: './'`, Vite generates absolute URLs starting with `/assets/...` which 404 on the Forge CDN. Result: blank screen, no errors in dev console pointing at the cause.

## When to apply

Trigger this skill any time you:
- Scaffold a new Custom UI module in a Forge app
- Migrate a Custom UI module from Webpack/CRA to Vite
- Debug a "white screen, no console errors" issue in a Forge Custom UI

## Verification

After build, the index.html in the build output should reference assets with relative paths:

```html
<!-- correct -->
<script type="module" src="./assets/index-abc123.js"></script>

<!-- wrong - will white-screen on Forge -->
<script type="module" src="/assets/index-abc123.js"></script>
```

If you see the absolute form, `base: './'` is missing.

## Source

The relative-base requirement follows Vite asset URL behavior and Forge's non-root Custom UI hosting path. Verify it against current official documentation when platform behavior changes.
