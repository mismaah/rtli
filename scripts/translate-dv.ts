/**
 * Generates `src/i18n/dv.ts` from `src/i18n/en.ts` with Gemini via OpenRouter.
 *
 *   npm run i18n:dv          # translate only the keys dv.ts is missing
 *   npm run i18n:dv -- --all # retranslate everything
 *
 * The key is read from OPENROUTER_API_KEY, or from `.openroutertoken` at the
 * repo root (gitignored). It is never logged and never written to the output.
 *
 * Machine translation is a starting point, not the last word: the generated
 * file is meant to be read by someone who speaks Dhivehi before it ships.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { en } from '../src/i18n/en';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/i18n/dv.ts');
const MODEL = 'google/gemini-3.8-flash';
const BATCH = 40;

/**
 * Keys whose English value is already Dhivehi, or is a brand or a currency the
 * feed itself prints in Latin. Copied across untouched.
 */
const VERBATIM = new Set(['languageBoth', 'languageEn', 'languageDv']);

const SYSTEM = `You translate UI strings for a bus trip planner used in Greater Malé, Maldives.
It plans journeys on RTL's public bus network: the rider picks a start and a destination, compares
itineraries, then follows step-by-step directions while walking to a stop, waiting, riding and getting off.

Translate from English into Dhivehi (Thaana script, dv-MV).

Rules:
- Return ONLY a JSON object with exactly the same keys you were given, and a Dhivehi string for each.
- Preserve every {token} EXACTLY as written, including its braces and spelling. Do not translate, reorder
  away, or add tokens. A string with {name} must come back with {name} in it.
- Keep Latin-script and numeric content as-is: RTL, MVR, km, km/h, m, route numbers, and all digits.
  Maldives uses Western Arabic numerals — do not convert digits to any other numeral system.
- Keep punctuation that carries meaning: an em dash, a middot separator, a leading "+" or "—".
- These are phone UI strings. Buttons and labels must stay short — match the English length where you can.
  Sentences of explanation may read naturally.
- Use the everyday spoken register a transit app would use, not formal or literary Dhivehi.
- Preserve capitalisation intent only where it survives translation; Thaana has no case.`;

type Entries = Record<string, string>;

function readKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = resolve(ROOT, '.openroutertoken');
  if (!existsSync(file)) {
    throw new Error('No OPENROUTER_API_KEY set and no .openroutertoken at the repo root.');
  }
  const key = readFileSync(file, 'utf8').trim();
  if (!key) throw new Error('.openroutertoken is empty.');
  return key;
}

/** What dv.ts already holds, so a rerun only pays for what is new. */
async function existingDv(): Promise<Entries> {
  if (!existsSync(OUT)) return {};
  try {
    const mod = (await import(OUT)) as { dv?: Entries };
    return mod.dv ?? {};
  } catch {
    return {};
  }
}

function tokensOf(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const THAANA = /[ހ-޿]/;

async function translateBatch(batch: Entries, apiKey: string): Promise<Entries> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(batch, null, 2) },
      ],
    }),
  });

  if (!res.ok) {
    // The body can echo request headers back; only the status is safe to print.
    throw new Error(`OpenRouter responded ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content.');

  // Models sometimes wrap JSON in a fence even when asked not to.
  const json = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(json) as Entries;
}

function serialise(entries: Entries): string {
  const body = Object.keys(en)
    .map((key) => `  ${key}: ${JSON.stringify(entries[key])},`)
    .join('\n');

  return `/**
 * Dhivehi catalogue — GENERATED, do not edit by hand.
 *
 * Produced by \`npm run i18n:dv\` (scripts/translate-dv.ts) from src/i18n/en.ts
 * using ${MODEL} via OpenRouter. Rerunning translates only the keys added since
 * the last run; pass \`-- --all\` to redo everything.
 *
 * Typed as \`Catalog\`, so a key added to en.ts breaks the build until it is
 * translated here.
 */
import type { Catalog } from './types';

export const dv: Catalog = {
${body}
};
`;
}

async function main() {
  const all = process.argv.includes('--all');
  const apiKey = readKey();
  const existing = all ? {} : await existingDv();

  const pending: Entries = {};
  for (const [key, value] of Object.entries(en)) {
    if (VERBATIM.has(key)) continue;
    if (existing[key]) continue;
    pending[key] = value;
  }

  const keys = Object.keys(pending);
  console.log(`${Object.keys(en).length} keys total, ${keys.length} to translate.`);

  const translated: Entries = { ...existing };
  for (const key of VERBATIM) translated[key] = en[key as keyof typeof en];

  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const batch: Entries = {};
    for (const key of slice) batch[key] = pending[key];

    process.stdout.write(`  batch ${i / BATCH + 1}: ${slice.length} keys… `);
    const out = await translateBatch(batch, apiKey);
    let missing = 0;
    for (const key of slice) {
      const value = out[key];
      if (typeof value !== 'string' || !value.trim()) {
        missing += 1;
        continue;
      }
      translated[key] = value.trim();
    }
    console.log(missing ? `${slice.length - missing} back, ${missing} missing` : 'ok');
  }

  // Validate before writing: a dropped {token} renders a broken sentence, and a
  // key that came back in English is a translation that silently did not happen.
  const problems: string[] = [];
  for (const [key, source] of Object.entries(en)) {
    const value = translated[key];
    if (!value) {
      problems.push(`${key}: missing`);
      continue;
    }
    const want = tokensOf(source).join(',');
    const got = tokensOf(value).join(',');
    if (want !== got) problems.push(`${key}: tokens {${want}} became {${got}}`);
    else if (!VERBATIM.has(key) && !THAANA.test(value)) problems.push(`${key}: no Thaana`);
  }

  const fatal = problems.filter((p) => p.includes('missing') || p.includes('tokens'));
  for (const problem of problems) console.warn(`  ! ${problem}`);
  if (fatal.length) {
    throw new Error(`${fatal.length} keys are unusable; not writing dv.ts.`);
  }

  writeFileSync(OUT, serialise(translated));
  console.log(`Wrote ${OUT} (${Object.keys(en).length} keys).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
