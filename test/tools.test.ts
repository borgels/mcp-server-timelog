import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/timelog/client.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createTimelogGateway, timelogGatewayTools } from '../src/gateway.js';
import { TIMELOG_TOOLS, executeTool, validateStartupConfig } from '../src/tools/timelog.js';
import { BASE, auditLines, connect, gateway, makeClient, texts } from './helpers.js';

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

// A project as TimeLog's REST API answers it (TAFSingle), with an amount that must not reach a result.
const item = { Properties: { ProjectID: 1, Name: 'First item', No: 'P-1', BudgetWorkAmount: 125000 }, Links: [{ Href: 'x', Rel: 'self' }] };
const reduced = { project: { ProjectID: 1, Name: 'First item', No: 'P-1' } };

describe('MCP tool surface', () => {
  it('registers every tool with matching annotations', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(TIMELOG_TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      const definition = TIMELOG_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
    }
  });

  it('runs the read tool and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`GET ${BASE}/api/v1/project/1`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'timelog_get_project', arguments: { projectId: 1 } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    expect(JSON.parse(json ?? '')).toEqual(reduced);
    expect(note).toContain('not instructions');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown arguments and path traversal', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const extra = await mcpClient.callTool({ name: 'timelog_get_project', arguments: { projectId: 1, other: 1 } });
    expect(extra.isError).toBe(true);
    const traversal = await mcpClient.callTool({ name: 'timelog_get_project', arguments: { projectId: '..' } });
    expect(traversal.isError).toBe(true);
    expect(texts(traversal).join(' ')).toContain('expected number');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the write tool unless writes are enabled, without calling upstream', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const result = await mcpClient.callTool({ name: 'timelog_create_task', arguments: { projectId: 1, name: 'New' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('TIMELOG_ENABLE_WRITES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the write tool when enabled and audits it', async () => {
    process.env.TIMELOG_ENABLE_WRITES = 'true';
    process.env.TIMELOG_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/api/v1/task`]: { status: 201, body: item } });
    const result = await mcpClient.callTool({
      name: 'timelog_create_task',
      arguments: { projectId: 1, name: 'First item', description: 'text' },
    });
    expect(result.isError).toBeFalsy();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ ProjectID: 1, TaskName: 'First item', Description: 'text' });

    const lines = auditLines(process.env.TIMELOG_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish']);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId);
    // Free text is hashed, never logged in clear text.
    expect(JSON.stringify(lines)).not.toContain('First item');
    expect((lines[0]?.target as Record<string, unknown>).nameSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.TIMELOG_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('TIMELOG_AUDIT_LOG');
    expect(() => createTimelogGateway({ apiKey: 'tttt-gggg-wwww-vvvv-1', baseUrl: BASE })).toThrow('TIMELOG_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect({ [`GET ${BASE}/api/v1/project/1`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'timelog_get_project', arguments: { projectId: 1 } });
    expect(result.isError).toBeFalsy();
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.TIMELOG_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/api/v1/task`]: { body: item } });
    // The log becomes unwritable after startup.
    process.env.TIMELOG_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const result = await mcpClient.callTool({ name: 'timelog_create_task', arguments: { projectId: 1, name: 'x' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Audit log is not writable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.TIMELOG_DISABLED_TOOLS = 'create_task';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('timelog_create_task');
    expect(tools).toHaveLength(TIMELOG_TOOLS.length - 1);

    process.env.TIMELOG_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { apiKey: 'k' } })).toThrow('TIMELOG_DISABLED_TOOLS');
  });

  it('logs only a summary of upstream errors', async () => {
    process.env.TIMELOG_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${BASE}/api/v1/project/1`]: { status: 400, body: { message: 'bad value: jane@vendor.test' } },
    });
    const result = await mcpClient.callTool({ name: 'timelog_get_project', arguments: { projectId: 1 } });
    expect(result.isError).toBe(true);
    const lines = auditLines(process.env.TIMELOG_AUDIT_LOG);
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    expect(JSON.stringify(lines)).not.toContain('jane@');
  });
});

describe('write gate beyond annotations', () => {
  it('gives read-only tools a client that refuses non-GET requests', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    const misannotated = {
      ...TIMELOG_TOOLS[0]!,
      name: 'timelog_get_project',
      handler: async (c: UpstreamClient) => c.post('/api/v1/task', { name: 'x' }),
    };
    await expect(executeTool(misannotated, client, { projectId: 1 })).rejects.toThrow(/Read-only tool .* POST/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = TIMELOG_TOOLS.find(t => t.name === 'timelog_get_project')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed: key test-api-key, header X-API-Key: other-secret, {"apiKey":"third-secret"}');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'timelog_get_project', arguments: { projectId: 1 } });
      expect(result.isError).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain('‹redacted›');
      for (const secret of ['test-api-key', 'other-secret', 'third-secret']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      tool.handler = original;
    }
  });
});

describe('gateway export', () => {
  it('exposes tools without the prefix and with valid JSON Schemas', () => {
    expect(timelogGatewayTools.map(t => [t.name, t.riskLevel, t.enabledByDefault])).toEqual([
      ['check_connection', 'read', true],
      ['list_projects', 'read', true],
      ['get_project', 'read', true],
      ['list_project_templates', 'read', true],
      ['list_tasks', 'read', true],
      ['get_task', 'read', true],
      ['list_customers', 'read', true],
      ['get_customer', 'read', true],
      ['list_employees', 'read', true],
      ['get_employee', 'read', true],
      ['list_time_registrations', 'read', true],
      ['get_time_registration', 'read', true],
      ['time_summary', 'read', true],
      ['timesheet_status', 'read', true],
      ['register_time', 'write', false],
      ['update_time', 'write', false],
      ['create_task', 'write', false],
      ['create_project', 'write', false],
      ['update_project', 'write', false],
    ]);
    const ajv = new Ajv({ strict: true });
    for (const tool of timelogGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input, applies the policy and records the caller', async () => {
    process.env.TIMELOG_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/api/v1/project/1`]: { body: item } });

    const ok = await gw.callTool('get_project', { projectId: 1 }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual(reduced);

    const invalid = await gw.callTool('get_project', { projectId: 1, extra: true });
    expect(invalid.isError).toBe(true);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    const write = await gw.callTool('create_task', { projectId: 1, name: 'x' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.TIMELOG_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: 'req-1', caller: 'user@vendor.test', action: 'start' });
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'rejected', 'rejected', 'policy_denied']);
  });
});

describe('default client', () => {
  it('is shared by servers created without a client, so its concurrency limit is process-wide', () => {
    const first = getDefaultClient();
    createServer();
    createServer();
    expect(getDefaultClient()).toBe(first);
  });
});
