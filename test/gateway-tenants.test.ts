import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, TimelogClient } from '../src/timelog/client.js';
import { createTimelogGateway, timelogGatewayTools, timelogToolCatalog } from '../src/gateway.js';
import { TIMELOG_TOOLS } from '../src/tools/timelog.js';
import { BASE, auditLines, connect, stubFetch, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timelog-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('TIMELOG_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Keys with no piece of six characters in common: the redactor also removes any such piece of its own key.
const KEY_A = 'alpha-0123456789-kq';
const KEY_B = 'bravo-zyxwvutsrq-MP';
const ENV_KEY = 'envkey-ABCDEFGHIJ-77';

/** Upstream that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('explicit gateway credentials', () => {
  it('requires apiKey and baseUrl and ignores the environment', () => {
    process.env.TIMELOG_API_KEY = ENV_KEY;
    process.env.TIMELOG_BASE_URL = BASE;

    expect(() => createTimelogGateway({ baseUrl: BASE } as never)).toThrow(/requires options\.apiKey/);
    expect(() => createTimelogGateway({ apiKey: KEY_A } as never)).toThrow(/requires options\.baseUrl/);
    expect(() => createTimelogGateway({ apiKey: '  ', baseUrl: BASE })).toThrow(/requires options\.apiKey/);
    expect(() => createTimelogGateway(undefined as never)).toThrow(/requires options\.apiKey/);
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = { ...process.env, TIMELOG_API_KEY: ENV_KEY, TIMELOG_BASE_URL: BASE };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createTimelogGateway({ baseUrl: BASE } as never)).toThrow(/requires options\.apiKey/);

    const fetchImpl = stubFetch({ [`GET ${BASE}/api/v1/project/1`]: { body: { id: 'i1' } } });
    const gw = createTimelogGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('get_project', { projectId: 1 });
    expect(result.isError).toBeUndefined();
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])[API_KEY_HEADER]).toBe(`Bearer ${KEY_A}`);

    expect(reads.has('TIMELOG_API_KEY')).toBe(false);
    expect(reads.has('TIMELOG_BASE_URL')).toBe(false);
  });

  it('still reads credentials from the environment in the standalone client', async () => {
    process.env.TIMELOG_API_KEY = ENV_KEY;
    process.env.TIMELOG_BASE_URL = BASE;
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    await new TimelogClient({ fetchImpl }).get('/items/1');
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)[API_KEY_HEADER]).toBe(`Bearer ${ENV_KEY}`);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own key in its tool results', async () => {
    const a = createTimelogGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: echoingFetch(KEY_A) });
    const b = createTimelogGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: echoingFetch(KEY_B) });

    const resultA = texts(await a.callTool('get_project', { projectId: 1 })).join(' ');
    const resultB = texts(await b.callTool('get_project', { projectId: 1 })).join(' ');
    // The echoing error body is never read into the result; the key is not there in any form.
    expect(resultA).not.toContain(KEY_A);
    expect(resultB).not.toContain(KEY_B);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = new TimelogClient({ apiKey: KEY_A, baseUrl: BASE, credentialEnv: {} });
    const b = new TimelogClient({ apiKey: KEY_B, baseUrl: BASE, credentialEnv: {} });
    expect(a.redactor.hasSecret(KEY_A)).toBe(true);
    expect(a.redactor.hasSecret(KEY_B)).toBe(false);
    expect(b.redactor.hasSecret(KEY_B)).toBe(true);
    expect(b.redactor.hasSecret(KEY_A)).toBe(false);
    // B neither knows nor needs A's key: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${KEY_A} b ${KEY_B}`)).toBe(`a=${KEY_A} b ‹redacted›`);
  });

  it('does not accumulate keys of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      createTimelogGateway({ apiKey: `short-lived-key-${index}`, baseUrl: BASE });
    }
    const fresh = new TimelogClient({ apiKey: KEY_A, baseUrl: BASE, credentialEnv: {} });
    expect(fresh.redactor.redact('short-lived-key-7')).toBe('short-lived-key-7');
  });

  it('redacts audit records with the key of the instance that ran the call', async () => {
    process.env.TIMELOG_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = createTimelogGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: failing(KEY_A), maxAttempts: 1 });
    const b = createTimelogGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: failing(KEY_B), maxAttempts: 1 });
    await a.callTool('get_project', { projectId: 1 }, { requestId: 'a' });
    await b.callTool('get_project', { projectId: 1 }, { requestId: 'b' });

    const errors = auditLines(process.env.TIMELOG_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual(['a', 'b']);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(KEY_A);
    expect(log).not.toContain(KEY_B);
  });

  it('redacts with the server client’s key on the MCP path', async () => {
    const tool = TIMELOG_TOOLS.find(t => t.name === 'timelog_get_project')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed with test-api-key');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'timelog_get_project', arguments: { projectId: 1 } });
      expect(texts(result).join(' ')).not.toContain('test-api-key');
    } finally {
      tool.handler = original;
    }
  });

  it('lets a dropped instance and its key be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createTimelogGateway> | undefined = createTimelogGateway({
      apiKey: fakeKey('collectable'),
      baseUrl: BASE,
    });
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

/** Sample input per tool, used to check each tool's declared upstream requests. */
const SAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  check_connection: {},
  list_projects: { customerId: 3 },
  get_project: { projectId: 1, includeTasks: true },
  list_project_templates: {},
  list_tasks: { projectId: 1 },
  get_task: { taskId: 5 },
  list_customers: { query: 'Nordlys' },
  get_customer: { customerId: 3 },
  list_employees: {},
  get_employee: { employeeId: 9 },
  list_time_registrations: { fromDate: '2026-11-02', toDate: '2026-11-06' },
  get_time_registration: { timeRegistrationId: 77 },
  time_summary: { fromDate: '2026-11-02', toDate: '2026-11-06' },
  timesheet_status: { fromDate: '2026-11-02', toDate: '2026-11-30' },
  register_time: { taskId: 5, date: '2026-11-03', hours: 1.5 },
  update_time: { timeRegistrationId: 77, hours: 2 },
  create_task: { projectId: 1, name: 'New task', parentTaskId: 5 },
  create_project: { templateId: 2, name: 'New project', customerId: 3 },
};

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(timelogToolCatalog.map(entry => entry.name)).toEqual(timelogGatewayTools.map(tool => tool.name));
    for (const entry of timelogToolCatalog) {
      const { upstream, broad, ...definition } = entry;
      expect(typeof broad).toBe('boolean');
      if (broad) expect(entry.riskLevel).toBe('read');
      expect(definition).toEqual(timelogGatewayTools.find(tool => tool.name === entry.name));
      expect(upstream.length).toBeGreaterThan(0);
      for (const operation of upstream) {
        expect(operation.access === 'read' ? operation.method === 'GET' : true).toBe(true);
        if (entry.riskLevel === 'read') {
          expect(operation.access).toBe('read');
        }
      }
    }

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      timelogToolCatalog.map(entry => `timelog_${entry.name}`).sort(),
    );
    for (const tool of tools) {
      const entry = timelogToolCatalog.find(e => `timelog_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(timelogToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(timelogToolCatalog);
    expect(() => {
      (timelogToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares exactly the upstream requests each tool makes', async () => {
    process.env.TIMELOG_ENABLE_WRITES = 'true';
    for (const entry of timelogToolCatalog) {
      const input = SAMPLE_INPUTS[entry.name];
      expect(input, `sample input for ${entry.name}`).toBeDefined();
      // One answer that every read can use, shaped as a TimeLog TAFSingle.
      const fetchImpl = vi.fn(async () => Response.json({ Properties: { TaskID: 5, Date: '2026-11-03T00:00:00', Hours: 1, Name: 'P' } }));
      const gw = createTimelogGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await gw.callTool(entry.name, input! as never);
      expect(result.isError, texts(result).join(' ')).toBeUndefined();

      const declared = entry.upstream.map(op => ({
        method: op.method,
        path: op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(input![name] ?? ''))),
      }));
      const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => ({
        method: init.method,
        path: new URL(url).pathname.slice(new URL(BASE).pathname.length),
      }));
      for (const request of made) {
        expect(declared, `${entry.name} made ${request.method} ${request.path}`).toContainEqual(request);
      }
    }
  });
});
