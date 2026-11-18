#!/usr/bin/env node
// Feeds a Dual Alpha / Dual Stream recording CSV (or a synthetic two-person session)
// through the same engine as the /dual-alpha page (signalChain -> DyadState ->
// WaveDecimator) and prints the contract v2 messages it would send to TouchDesigner.
//
//   node scripts/replay-to-socket.mjs                      # 60 s synthetic session, summary
//   node scripts/replay-to-socket.mjs rec.csv              # a recording exported by either page
//   node scripts/replay-to-socket.mjs --seconds 120 --print 5
//   node scripts/replay-to-socket.mjs rec.csv --jsonl out.jsonl      # td_stream.jsonl-style capture
//   node scripts/replay-to-socket.mjs rec.csv --send ws://localhost:9000   # real time, to TD
//   options: --mains 50, --enter 4
import { register } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

register('./ts-loader.mjs', import.meta.url);
const { DualAlphaEngine } = await import('../src/lib/dual-alpha/engine.ts');
const { parseRecordingCsv } = await import('../src/lib/dual-alpha/recorder.ts');
const { synthDualRows } = await import('../tests/synth.ts');

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
};
const seconds = Number(opt('seconds', 60));
const printN = Number(opt('print', 3));
const jsonlPath = opt('jsonl', null);
const sendUrl = opt('send', null);
const mains = Number(opt('mains', 60));
const enterDb = Number(opt('enter', 5));
const csvPath = args[0];

let rows;
if (csvPath) {
    rows = parseRecordingCsv(readFileSync(csvPath, 'utf8')).rows;
    console.log(`recording: ${csvPath}, ${rows.length} rows`);
} else {
    rows = synthDualRows(seconds);
    console.log(`synthetic two-person session: ${seconds} s, ${rows.length} rows`);
}

const engine = new DualAlphaEngine({ mains, enterDb });
const messages = [];   // [t_ms, msg]
const t0 = rows[0]?.[1] ?? 0;
for (const r of rows) {
    const slot = r[0] === 2 ? 2 : 1;
    const out = engine.ingest(slot, [r[4], r[5], r[6]], r[1]);
    if (out.message) messages.push([r[1] - t0, out.message]);
}

// ── summary ──
const spanS = ((rows[rows.length - 1]?.[1] ?? 0) - t0) / 1000;
const keys = new Set(messages.map(([, m]) => Object.keys(m).join(',')));
let gaps = 0;
for (let i = 1; i < messages.length; i++) if (messages[i][1].n !== messages[i - 1][1].n + 16) gaps++;
const bytes = messages.reduce((a, [, m]) => a + JSON.stringify(m).length, 0);
const share = (f) => (messages.filter(([, m]) => f(m)).length / Math.max(1, messages.length) * 100).toFixed(0) + '%';
const msgSpanS = messages.length > 1 ? (messages.at(-1)[0] - messages[0][0]) / 1000 : 0;
console.log(`messages: ${messages.length} in ${spanS.toFixed(1)} s of signal; ` +
    `${((messages.length - 1) / Math.max(msgSpanS, 1e-9)).toFixed(2)} per s from the first message (after the 2 s detector warm-up) to the last`);
console.log(`key sets: ${keys.size} -> ${[...keys].map((k) => `${k.split(',').length} keys [${k}]`).join(' | ')}`);
console.log(`n: ${messages[0]?.[1].n} .. ${messages.at(-1)?.[1].n}, gaps: ${gaps}; ${(bytes / Math.max(1, messages.length)).toFixed(0)} bytes per message`);
console.log(`waveform lengths: ${[...new Set(messages.flatMap(([, m]) => [m.d1_w.length, m.d2_w.length]))].join(',')}; v=${[...new Set(messages.map(([, m]) => m.v))]} fs=${[...new Set(messages.map(([, m]) => m.fs))]}`);
console.log(`d1 ok ${share((m) => m.d1_ok)}, in alpha ${share((m) => m.d1_level > 0)}; d2 ok ${share((m) => m.d2_ok)}, in alpha ${share((m) => m.d2_level > 0)}; pair ${share((m) => m.pair_level > 0)}`);
const step = Math.max(1, Math.floor(messages.length / Math.max(1, printN)));
for (let i = 0; i < messages.length && printN > 0; i += step) {
    const [t, m] = messages[i];
    const short = { ...m, d1_w: `[${m.d1_w.slice(0, 3).join(',')},…${m.d1_w.length}]`, d2_w: `[${m.d2_w.slice(0, 3).join(',')},…${m.d2_w.length}]` };
    console.log(`t=${(t / 1000).toFixed(2)}s`, JSON.stringify(short));
}

if (jsonlPath) {
    writeFileSync(jsonlPath, messages.map(([t, m]) => JSON.stringify({ t_ms: Math.round(t), msg: m })).join('\n') + '\n');
    console.log(`wrote ${messages.length} lines to ${jsonlPath}`);
}

if (sendUrl) {
    const ws = new WebSocket(sendUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot connect to ${sendUrl}`)); });
    console.log(`sending to ${sendUrl} in real time…`);
    const start = performance.now();
    for (const [t, m] of messages) {
        const wait = t - (performance.now() - start);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        ws.send(JSON.stringify(m));
    }
    ws.close();
    console.log('done');
}
