// Lets plain Node (22.x) run the app's TypeScript modules for tests and scripts:
//   node --import ./scripts/ts-hooks.mjs --test "src/**/*.test.ts"
// Resolves the "@/" alias and extensionless imports the way tsconfig does, and
// transpiles .ts/.tsx with the project's own `typescript` package (types are dropped,
// nothing is type-checked; `next build` does that).
import { register } from 'node:module';

register('./ts-loader.mjs', import.meta.url);
