// Seeded identity: the forge cannot learn the token owner's login from the
// bearer token (it is opaque), so it re-derives the scenario's first user
// from the same fixed seed the suite uses. Same seed, same user, every run:
// no clock, no randomness anywhere in this file.

const SEED = 0x6a09e667f3bcc909n;
const MASK64 = 0xffffffffffffffffn;

function fnv(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const ch of text) {
    h ^= BigInt(ch.charCodeAt(0));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

function scramble(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** xorshift64* stream, seeded per label. */
function streamFor(label: string): () => number {
  let state = scramble(SEED ^ fnv(label));
  if (state === 0n) state = SEED;
  return () => {
    let x = state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & MASK64) >> 32n);
  };
}

const GIVEN = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;

const FAMILY = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface Account {
  id: number;
  login: string;
  name: string;
  email: string;
}

function buildAccounts(total: number): Account[] {
  const next = streamFor('users');
  const take = (max: number): number => {
    const range = 4_294_967_296;
    const limit = range - (range % max);
    for (;;) {
      const v = next();
      if (v < limit) return v % max;
    }
  };
  const seen = new Set<string>();
  const out: Account[] = [];
  for (let i = 0; i < total; i++) {
    const first = GIVEN[take(GIVEN.length)] as string;
    const last = FAMILY[take(FAMILY.length)] as string;
    let login = `${first}${last}`;
    let n = 2;
    while (seen.has(login)) {
      login = `${first}${last}-${n}`;
      n++;
    }
    seen.add(login);
    out.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return out;
}

const ACCOUNTS = buildAccounts(12);

/** The viewer: accounts[0]. Teammate is [1], stranger is [2]. */
export const VIEWER: Account = ACCOUNTS[0] as Account;
export const STRANGER_LOGIN: string = (ACCOUNTS[2] as Account).login;

/** Default branch for every new repository. */
export const MAIN_BRANCH = 'main';

/** Identity the forge signs its own commits with (the viewer's). */
export const SIGNATURE = `${VIEWER.name} <${VIEWER.email}>`;

/** Fixed epoch for every commit the forge creates. */
export const EPOCH = 1700000000;
/** Fixed ISO timestamp for created_at / updated_at / merged_at in state. */
export const ISO_NOW = '2024-01-01T00:00:00Z';
