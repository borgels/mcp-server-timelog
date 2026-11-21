// One property, proved through every channel at once: no piece of an instance's key (six characters or more)
// reaches a host result, a thrown error or an audit record. The key has a quote and a backslash, so a form
// that is serialised before it is redacted would show; the upstream echoes the key whole, in fragments, in
// keys, in error bodies and codes, in a redirect's Location and in an over-limit body; the environment holds
// it where a number or a switch was expected.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRAGMENT_LENGTH, MAX_REDACT_DEPTH, redactDeep, SecretRedactor } from '../src/errors.js';
import { createTimelogGateway, type GatewayToolResult } from '../src/gateway.js';
import { BASE, gateway } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const FRAGMENT = KEY.slice(0, 12);
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('TIMELOG_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** Every string in a value, object keys included. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(entry => strings(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      strings(entry, out);
    }
  }
  return out;
}

/** The pieces of the key that are found anywhere in `value`, raw or serialised. */
function leaks(value: unknown): string[] {
  const texts = [...strings(value), JSON.stringify(value) ?? ''];
  const found = new Set<string>();
  for (let i = 0; i + FRAGMENT_LENGTH <= KEY.length; i += 1) {
    const piece = KEY.slice(i, i + FRAGMENT_LENGTH);
    if (texts.some(text => text.includes(piece))) found.add(piece);
  }
  return [...found];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** The upstream: each item id answers through one channel. */
const upstream: typeof fetch = async (input, init) => {
  const url = String(input).split('?')[0] ?? '';
  let path = url.slice(BASE.length);
  // A project's tasks are one path with the project in the query.
  if (path === '/api/v1/task') path = `${path}?projectID=${new URL(String(input)).searchParams.get('projectID') ?? ''}`;
  if (init?.method === 'POST') return json({ id: 'new', echo: KEY, [KEY]: FRAGMENT }, 201);
  switch (path) {
    case '/api/v1/project/101':
      return json({
        Properties: { ProjectID: 101, Name: KEY, Description: FRAGMENT, No: FRAGMENT, [KEY]: 1, [`k ${FRAGMENT}`]: { deeper: [FRAGMENT, KEY] } },
        Links: [{ Href: `${BASE}/${KEY}`, Rel: 'self' }],
      });
    case '/api/v1/project/102':
      return json({ message: `Rejected ${KEY}`, code: FRAGMENT, details: { [KEY]: FRAGMENT } }, 400);
    case '/api/v1/project/103':
      return json({ code: FRAGMENT, error: FRAGMENT }, 401);
    case '/api/v1/project/104':
      return new Response(`${' '.repeat(70_000)}${KEY}`, { status: 500, headers: { 'content-type': 'text/plain' } });
    case '/api/v1/project/105':
      return new Response(`"${' '.repeat(2_000)}${KEY}"`, { status: 200, headers: { 'content-type': 'application/json' } });
    case '/api/v1/project/106':
      return new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${FRAGMENT}?k=${KEY}` } });
    case '/api/v1/project/107':
      throw new TypeError(`fetch failed for ${KEY}`, { cause: Object.assign(new Error(`connect ${FRAGMENT}`), { code: FRAGMENT }) });
    case '/api/v1/project/108':
      return json({ name: 'ok' });
    case '/api/v1/task?projectID=108':
      return json({ message: `history rejected ${FRAGMENT}`, code: FRAGMENT }, 401);
    case '/api/v1/project/109':
      return json({ name: 'ok' });
    case '/api/v1/task?projectID=109':
      return new Response(null, { status: 307, headers: { location: `/${FRAGMENT}` } });
    default:
      return json({ message: `no stub ${KEY}` }, 404);
  }
};

describe('no piece of the key leaves an instance', () => {
  it('holds for every channel: results, errors, nested failures and audit records', async () => {
    const records: unknown[] = [];
    const gw = createTimelogGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: upstream,
      maxAttempts: 1,
      maxResponseBytes: 1_000,
      policy: { enableWrites: true, audit: record => void records.push(record) },
    });
    const results: GatewayToolResult[] = [];
    for (const projectId of [101, 102, 103, 104, 105, 106, 107, 121]) {
      results.push(await gw.callTool('get_project', { projectId }, { caller: `caller ${KEY}`, requestId: FRAGMENT }));
    }
    const combined = await gw.callTool('get_project', { projectId: 108, includeTasks: true });
    const redirected = await gw.callTool('get_project', { projectId: 109, includeTasks: true });
    results.push(combined, redirected, await gw.callTool('create_task', { projectId: 1, name: KEY }));
    results.push(await gw.callTool(`get_project ${KEY}`, {}), await gw.callTool('get_project', { projectId: 120, [KEY]: FRAGMENT }));

    expect(results[0]?.isError).toBeUndefined();
    expect(combined.structuredContent).toMatchObject({ tasks: { error: 'Timelog API request failed with HTTP 401' } });
    expect(redirected.structuredContent).toMatchObject({ tasks: { error: 'Timelog API request failed.' } });
    expect(records.length).toBeGreaterThan(10);
    expect(leaks(results)).toEqual([]);
    expect(leaks(records)).toEqual([]);
  });

  it('holds for errors about the environment, with or without an instance', async () => {
    const answers: unknown[] = [];
    for (const name of ['TIMELOG_ENABLE_WRITES', 'TIMELOG_DISABLED_TOOLS', 'TIMELOG_TIMEOUT_MS', 'TIMELOG_MAX_CONCURRENCY', 'TIMELOG_MAX_RESPONSE_BYTES']) {
      process.env[name] = KEY;
      try {
        // Without a host policy the environment applies: the bad value fails at creation or at the call.
        const gw = createTimelogGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: upstream });
        answers.push(await gw.callTool('create_task', { projectId: 1, name: 'x' }));
      } catch (error) {
        answers.push((error as Error).message);
      }
      delete process.env[name];
    }
    expect(answers.filter(answer => typeof answer === 'string' || (answer as GatewayToolResult).isError)).toHaveLength(5);
    expect(leaks(answers)).toEqual([]);
  });
});

describe('redactDeep', () => {
  it('replaces anything deeper than its limit, strings at the limit included, and redacts what is above it', () => {
    const redactor = new SecretRedactor().addSecret(KEY);
    let value: unknown = KEY;
    for (let i = 0; i < MAX_REDACT_DEPTH; i += 1) value = [value];
    // The string sits at depth MAX_REDACT_DEPTH: redacted, not replaced.
    expect(JSON.stringify(redactDeep(value, redactor))).toContain('‹redacted›');
    expect(JSON.stringify(redactDeep([value], redactor))).toContain('[nested too deep]');
    expect(leaks(redactDeep([value], redactor))).toEqual([]);
  });
});

describe('the data in the text block', () => {
  it('carries the redacted structured content as compact JSON after the summary', async () => {
    const gw = createTimelogGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: upstream, maxAttempts: 1 });
    const result = await gw.callTool('get_project', { projectId: 101 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const [summary, data, ...rest] = result.content[0]!.text.split('\n\n');
    expect(summary).not.toBe('');
    expect(summary).not.toContain('{');
    expect(rest).toEqual([]);
    expect(data).toBe(JSON.stringify(result.structuredContent));
    expect(data).not.toContain('\n');
    expect(data).toContain('‹redacted›');
    expect(leaks(result)).toEqual([]);
  });

  it('gives a client that reads only the text the data', async () => {
    const { gw } = gateway({ [`GET ${BASE}/api/v1/project/7`]: { body: { Properties: { ProjectID: 7, Name: 'Testvare Blå' } } } });
    const result = await gw.callTool('get_project', { projectId: 7 });
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]!.text).toContain('"Name":"Testvare Blå"');
    expect(result.content[0]!.text.endsWith(JSON.stringify(result.structuredContent))).toBe(true);
  });

  it('leaves error results with their text only', async () => {
    const gw = createTimelogGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: upstream, maxAttempts: 1 });
    const result = await gw.callTool('get_project', { projectId: 102 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).not.toContain('\n\n{');
  });
});
