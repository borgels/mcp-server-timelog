// The rest of the threat model (README, "Threat model"), through callTool: a key that is a number and pieces of it in
// numbers, an error while reading a successful body, failures reported inside a successful body, and a result too
// deep to serialise naively. Every result must still be valid JSON.
import { describe, expect, it, vi } from 'vitest';
import { createTimelogGateway } from '../src/gateway.js';
import { BASE } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const DEEP = 20_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failingBody = (message: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new Error(message));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function stub(key: string): typeof fetch {
  return async input => {
    let path = (String(input).split('?')[0] ?? '').slice(BASE.length);
    if (path === '/api/v1/task') path = `${path}?projectID=${new URL(String(input)).searchParams.get('projectID') ?? ''}`;
    switch (path) {
      case '/api/v1/project/110':
        return json({ Properties: { ProjectID: Number(key), BudgetWorkHours: Number(key.slice(1, 7)), DepartmentID: Number(`${key}9`), Name: 'ok', CustomerID: 3 } });
      case '/api/v1/project/111':
        // The vendor's text and a piece of the key shorter than six characters.
        return failingBody(`Vendor diagnostic ${key.slice(0, 5)}`);
      case '/api/v1/project/112':
        return json({
          metadata: { status: 401, error: `Vendor diagnostic ${key}` },
          failures: [{ status: 403, error: 'Vendor detail' }, { error: 'Vendor text' }],
        });
      case '/api/v1/task?projectID=112':
        return json({ entries: [], failures: [{ status: 500, error: 'Vendor history detail' }] });
      case '/api/v1/project/113':
        return new Response(`${'['.repeat(DEEP)}1${']'.repeat(DEEP)}`, { status: 200, headers: { 'content-type': 'application/json' } });
      default:
        return json({ message: 'no stub' }, 404);
    }
  };
}

describe('the threat model, through callTool', () => {
  it('redacts a numeric key and its pieces in numbers, and the result stays valid JSON', async () => {
    const key = '1234567890123456';
    const records: unknown[] = [];
    const gw = createTimelogGateway({ apiKey: key, baseUrl: BASE, fetchImpl: stub(key), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_project', { projectId: 110 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      project: { ProjectID: '‹redacted›', BudgetWorkHours: '‹redacted›', DepartmentID: '‹redacted›', Name: 'ok', CustomerID: 3 },
    });
    const serialised = JSON.stringify(result);
    expect(JSON.parse(serialised)).toEqual(result);
    expect(serialised).not.toMatch(/234567|12345678/);
    expect(JSON.stringify(records)).not.toMatch(/234567|12345678/);
  });

  it('turns an error while reading a successful body into a fixed text, for the host and the audit', async () => {
    const records: unknown[] = [];
    const gw = createTimelogGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_project', { projectId: 111 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('The Timelog API response could not be read.');
    for (const value of [result, records]) {
      expect(JSON.stringify(value)).not.toContain('Vendor');
      expect(JSON.stringify(value)).not.toContain(JSON.stringify(KEY.slice(0, 5)).slice(1, -1));
    }
  });

  it('drops failures reported inside a successful body: only listed fields reach a result', async () => {
    const gw = createTimelogGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1 });
    const result = await gw.callTool('get_project', { projectId: 112, includeTasks: true });
    expect(result.structuredContent).toEqual({ project: {}, tasks: [] });
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });

  it('answers a very deep result without exhausting the stack', async () => {
    const gw = createTimelogGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1, maxResponseBytes: 1_000_000 });
    const result = await gw.callTool('get_project', { projectId: 113 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ project: null });
  });
});

describe('round 5 of the threat model, through callTool', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses a key that overlaps the redaction marker, and redacts one that looks like the old marker', async () => {
    for (const apiKey of ['‹redacted›-0123456789', 'my-redacted-value', 'xx-dacted›-yy']) {
      expect(() => createTimelogGateway({ apiKey, baseUrl: BASE }), apiKey).toThrow(/key was refused/);
    }
    const LOOKALIKE = '[REDACTED]-0123456789';
    const records: unknown[] = [];
    const gw = createTimelogGateway({
      apiKey: LOOKALIKE,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () => json({ echo: LOOKALIKE, [LOOKALIKE]: 1 }),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_project', { projectId: LOOKALIKE }, { caller: LOOKALIKE });
    const text = JSON.stringify([result, records]);
    for (const piece of pieces(LOOKALIKE)) expect(text, piece).not.toContain(piece);
  });

  it('keeps only the status of a failure object, on reads and on create_task', async () => {
    const body = {
      metadata: { status: 401, error: 'Vendor diagnostic', message: 'Vendor message', code: 'VENDOR_CODE', detail: { more: 'Vendor' } },
      failures: [{ error: 'Vendor text', hint: 'Vendor hint' }],
    };
    const gw = createTimelogGateway({
      apiKey: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async (_input, init) => json(body, init?.method === 'POST' ? 201 : 200),
      policy: { enableWrites: true },
    });
    for (const result of [await gw.callTool('get_project', { projectId: 120 }), await gw.callTool('create_task', { projectId: 1, name: 'n' })]) {
      expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/Vendor|VENDOR/);
      expect([{ project: {} }, { accepted: true, projectId: 1 }]).toContainEqual(result.structuredContent);
    }
  });

  it('gives our own text when the body of a failed response cannot be read', async () => {
    const records: unknown[] = [];
    const gw = createTimelogGateway({
      apiKey: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`Vendor diagnostic ${KEY.slice(0, 5)}`));
            },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_project', { projectId: 120 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Timelog API request failed with HTTP 500/);
    expect(JSON.stringify([result, records])).not.toContain('Vendor');
  });

  it('redacts an audit sink failure before it reaches stderr', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });
    try {
      const gw = createTimelogGateway({
        apiKey: KEY,
        baseUrl: BASE,
        maxAttempts: 1,
        fetchImpl: async () => json({ name: 'ok' }),
        policy: {
          audit: () => {
            throw new Error(`sink failed for ${KEY}`);
          },
        },
      });
      const result = await gw.callTool('get_project', { projectId: 120 });
      expect(result.isError).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const text = written.join('');
    expect(text).toContain('audit log write failed');
    for (const piece of pieces(KEY)) expect(text, piece).not.toContain(piece);
  });
});

describe('round 6 of the threat model', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses keys that collide with our own texts, without repeating them', () => {
    for (const apiKey of ['[nested too deep]-0123456789', 'timelog-mcp-0123456789', 'TIMELOG_BASE_URL-0123456789']) {
      let message = '';
      try {
        createTimelogGateway({ apiKey, baseUrl: BASE });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, apiKey).toMatch(/key was refused/);
      for (const piece of pieces(apiKey)) expect(message, piece).not.toContain(piece);
    }
  });

  it('sends a construction error through the redactor, configuration values included', () => {
    const HOSTLIKE = 'qz7hn4vb8lw2jx6pz9';
    let message = '';
    try {
      createTimelogGateway({ apiKey: HOSTLIKE, baseUrl: `https://${HOSTLIKE}.vendor.invalid/x?y=${HOSTLIKE}`, policy: {} });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const piece of pieces(HOSTLIKE)) expect(message, piece).not.toContain(piece);
  });

  it('reduces failures without an error field, by status or in a failure context', async () => {
    const gw = createTimelogGateway({
      apiKey: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () =>
        json({
          failures: [{ status: 403, message: 'Vendor diagnostic' }],
          metadata: { status: 401, error: null, message: 'Vendor diagnostic' },
          errors: [{ message: 'Vendor diagnostic' }],
          rows: [{ status: 200, message: 'kept' }],
        }),
    });
    const result = await gw.callTool('get_project', { projectId: 120 });
    expect(result.structuredContent).toEqual({ project: {} });
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });

  it('names a network error code only from the fixed list', async () => {
    const gw = createTimelogGateway({
      apiKey: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'VENDOR_DIAGNOSTIC' }) });
      },
    });
    const result = await gw.callTool('get_project', { projectId: 120 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('VENDOR_DIAGNOSTIC');
  });
});
