// Module hooks registered by ts-hooks.mjs. See there.
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const EXTS = ['.ts', '.tsx', '.js', '.mjs'];

function findFile(base) {
    if (existsSync(base) && statSync(base).isFile()) return base;
    for (const e of EXTS) if (existsSync(base + e)) return base + e;
    for (const e of EXTS) {
        const idx = path.join(base, 'index' + e);
        if (existsSync(idx)) return idx;
    }
    return null;
}

export async function resolve(specifier, context, next) {
    const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : null;
    const inProject = parent && !parent.includes(`${path.sep}node_modules${path.sep}`);
    if (inProject) {
        let base = null;
        if (specifier.startsWith('@/')) {
            for (const dir of ['src', 'workers']) {
                const f = findFile(path.join(ROOT, dir, specifier.slice(2)));
                if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
            }
        } else if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
            base = path.resolve(path.dirname(parent), specifier);
            const f = findFile(base);
            if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
        }
    }
    return next(specifier, context);
}

export async function load(url, context, next) {
    if (url.startsWith('file:') && /\.tsx?$/.test(url) && !url.includes('/node_modules/')) {
        const file = fileURLToPath(url);
        const src = await readFile(file, 'utf8');
        const out = ts.transpileModule(src, {
            fileName: file,
            compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2022,
                jsx: ts.JsxEmit.ReactJSX,
                sourceMap: false,
                inlineSourceMap: true,
            },
        });
        return { format: 'module', source: out.outputText, shortCircuit: true };
    }
    return next(url, context);
}
