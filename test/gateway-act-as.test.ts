import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATED_BY_KEY_USER_ONLY,
  createTimelogGateway,
  NOT_OWN_REGISTRATION,
  OTHER_EMPLOYEE,
  OWN_TIME_ONLY,
  timelogToolCatalog,
} from '../src/gateway.js';
import { LOOKUP_MAX_PAGES } from '../src/timelog/act-as-user.js';
import { BASE } from './helpers.js';

/**
 * Acting as a person (src/act-as.ts): every change is made for the TimeLog user found by the host's verified email,
 * or not at all; the period reads of time run only for the key's own user. TimeLog is mocked with answers shaped as
 * its REST read models (TAFList/TAFSingle).
 */

const KEY = 'pat-aaaa-bbbb-cccc-dddd-1';
const EMAIL = 'mette@example.com';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('TIMELOG_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const single = (properties: Record<string, unknown>) => ({ Properties: properties, Links: [] });
/** A TAFList page; `total` is the record count of the whole list (TotalRecord), by default this page's. */
const list = (entities: Array<Record<string, unknown>>, page = 1, pages = 1, total = entities.length) => ({
  Properties: { TotalRecord: String(total), TotalPage: String(pages), PageNumber: String(page) },
  Entities: entities.map(properties => ({ Properties: properties, Links: [] })),
  Links: [],
});

const KEY_USER = { UserID: 1, FirstName: 'Admin', LastName: 'Bruger', Email: 'admin@example.com', IsActive: true };
const METTE = { UserID: 7, FirstName: 'Mette', LastName: 'Hansen', Email: ' Mette@Example.com ', IsActive: true };
const OTHER = { UserID: 8, FirstName: 'Ole', LastName: 'Jensen', Email: 'ole@example.com', IsActive: true };
const REGISTRATION = (userId: number) => ({
  TimeRegistrationID: 77,
  TaskID: 5,
  Date: '2026-11-03T00:00:00',
  Hours: 2,
  BillableHours: 2,
  IsBillable: true,
  Comment: 'Skitser',
  AbsenceCodeID: 0,
  UserID: userId,
});

type Route = { status?: number; body?: unknown } | ((query: Record<string, string>) => { status?: number; body?: unknown });

function upstream(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; query: Record<string, string>; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    const method = init?.method ?? 'GET';
    const query = Object.fromEntries(url.searchParams);
    calls.push({ method, path, query, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const found = routes[`${method} ${path}`];
    const route = typeof found === 'function' ? found(query) : found;
    if (!route) return Response.json({ Code: 404, Message: 'Not found' }, { status: 404 });
    return Response.json(route.body ?? {}, { status: route.status ?? 200 });
  });
  const audit: Array<Readonly<Record<string, unknown>>> = [];
  const gw = createTimelogGateway({
    apiKey: KEY,
    baseUrl: BASE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxAttempts: 1,
    policy: { enableWrites: true, audit: record => void audit.push(record) },
  });
  return { gw, calls, audit };
}

const USERS = { 'GET /api/v1/user': { body: list([KEY_USER, METTE, OTHER]) } };
const writes = <T extends { method: string }>(calls: T[]): T[] => calls.filter(call => call.method !== 'GET');
const asMette = { caller: 'p-1', actAs: { email: EMAIL } };

describe('changes as the person in actAs', () => {
  it('register_time finds the person on every page of users and registers the time on their UserID', async () => {
    const { gw, calls, audit } = upstream({
      ...USERS,
      'POST /api/v1/time-registration': { body: single(REGISTRATION(7)) },
    });
    const result = await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2 }, asMette);
    expect(result.isError).toBeUndefined();
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/v1/user', 'POST /api/v1/time-registration']);
    expect(calls[0]?.query).toMatchObject({ $page: '1', $pagesize: '500' });
    expect(calls[1]?.body).toMatchObject({ TaskID: 5, UserID: 7 });
    // The email is sent to TimeLog nowhere, and is in no audit record and no result.
    expect(JSON.stringify(calls)).not.toContain('mette');
    expect(JSON.stringify(audit).toLowerCase()).not.toContain('mette');
    expect(JSON.stringify(result).toLowerCase()).not.toContain(EMAIL);
  });

  it('refuses without sending anything when the person has no user, an inactive one or more than one', async () => {
    for (const users of [[KEY_USER, OTHER], [KEY_USER, { ...METTE, IsActive: false }], [METTE, { ...METTE, UserID: 9 }]]) {
      const { gw, calls } = upstream({ 'GET /api/v1/user': { body: list(users) } });
      const result = await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2 }, asMette);
      expect(result).toMatchObject({ isError: true, actAsRefused: 'no_user' });
      expect(result.content[0]?.text).not.toContain(EMAIL);
      expect(writes(calls)).toEqual([]);
    }
  });

  it('reads the user list to its last page, and refuses a list longer than it reads', async () => {
    const paged = upstream({
      'GET /api/v1/user': query =>
        query.$page === '1' ? { body: list([KEY_USER], 1, 2, 2) } : { body: list([METTE], 2, 2, 2) },
      'POST /api/v1/time-registration': { body: single(REGISTRATION(7)) },
    });
    const ok = await paged.gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2 }, asMette);
    expect(ok.isError).toBeUndefined();
    expect(paged.calls.filter(call => call.path === '/api/v1/user').map(call => call.query.$page)).toEqual(['1', '2']);

    const long = upstream({
      'GET /api/v1/user': query => ({
        body: list([Number(query.$page) === LOOKUP_MAX_PAGES ? METTE : OTHER], Number(query.$page), LOOKUP_MAX_PAGES + 1, LOOKUP_MAX_PAGES + 1),
      }),
    });
    const refused = await long.gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2 }, asMette);
    expect(refused).toMatchObject({ isError: true, actAsRefused: 'no_user' });
    expect(long.calls.filter(call => call.path === '/api/v1/user')).toHaveLength(LOOKUP_MAX_PAGES);
    expect(writes(long.calls)).toEqual([]);
  });

  it('accepts a match only when the whole list was read: no early stop on an empty page, a missing count or a short count', async () => {
    const answers: Array<(page: number) => unknown> = [
      // A match on page 1, an empty page 2, and TimeLog announcing three pages: a second match could be on page 3.
      page => (page === 1 ? list([METTE], 1, 3, 3) : list([], page, 3, 3)),
      // No paging information on a TAFList.
      () => ({ Entities: [{ Properties: METTE }], Links: [] }),
      // The last page, but fewer records read than TimeLog counts.
      () => list([METTE], 1, 1, 2),
      // A match on the first page and the same address again on the last.
      page => (page === 1 ? list([METTE, KEY_USER], 1, 2, 3) : list([{ ...METTE, UserID: 9 }], 2, 2, 3)),
    ];
    for (const answer of answers) {
      const { gw, calls } = upstream({ 'GET /api/v1/user': query => ({ body: answer(Number(query.$page)) }) });
      const result = await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2 }, asMette);
      expect(result).toMatchObject({ isError: true, actAsRefused: 'no_user' });
      expect(writes(calls)).toEqual([]);
    }
    // A plain array is the whole list.
    const plain = upstream({ 'GET /api/v1/user': { body: [KEY_USER, METTE] }, 'POST /api/v1/time-registration': { body: single(REGISTRATION(7)) } });
    expect((await plain.gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2 }, asMette)).isError).toBeUndefined();
  });

  it('is not_permitted when TimeLog will not show the key user the users', async () => {
    const { gw, calls } = upstream({ 'GET /api/v1/user': { status: 403, body: { Message: 'Forbidden' } } });
    const result = await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2 }, asMette);
    expect(result).toMatchObject({ isError: true, actAsRefused: 'not_permitted' });
    expect(writes(calls)).toEqual([]);
  });

  it('refuses a malformed actAs before anything is sent, null included', async () => {
    for (const actAs of [null, { email: 'not-an-email' }, { email: 42 }, 'mette@example.com']) {
      const { gw, calls } = upstream(USERS);
      const result = await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2 }, { actAs } as never);
      expect(result).toMatchObject({ isError: true, actAsRefused: 'invalid' });
      expect(calls).toEqual([]);
    }
  });

  it('register_time for another employee is refused; for the person themselves it goes through', async () => {
    const other = upstream(USERS);
    const refused = await other.gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2, employeeId: 8 }, asMette);
    expect(refused).toMatchObject({ isError: true, content: [{ text: OTHER_EMPLOYEE }] });
    expect(refused.actAsRefused).toBeUndefined();
    expect(writes(other.calls)).toEqual([]);

    const own = upstream({ ...USERS, 'POST /api/v1/time-registration': { body: single(REGISTRATION(7)) } });
    const ok = await own.gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2, employeeId: 7 }, asMette);
    expect(ok.isError).toBeUndefined();
    expect(writes(own.calls)[0]?.body).toMatchObject({ UserID: 7 });
  });

  it("update_time changes only the person's own registration", async () => {
    const theirs = upstream({ ...USERS, 'GET /api/v1/time-tracking-item/77': { body: single(REGISTRATION(8)) } });
    const refused = await theirs.gw.callTool('update_time', { timeRegistrationId: 77, hours: 3 }, asMette);
    expect(refused).toMatchObject({ isError: true, content: [{ text: NOT_OWN_REGISTRATION }] });
    expect(writes(theirs.calls)).toEqual([]);

    const own = upstream({
      ...USERS,
      'GET /api/v1/time-tracking-item/77': { body: single(REGISTRATION(7)) },
      'POST /api/v1/time-registration/update-time': { body: single(REGISTRATION(7)) },
    });
    const ok = await own.gw.callTool('update_time', { timeRegistrationId: 77, hours: 3 }, asMette);
    expect(ok.isError).toBeUndefined();
    expect(writes(own.calls)[0]?.body).toMatchObject({ TimeRegistrationID: 77, Hours: 3 });
  });

  it("create_task and create_project run only when the person is the key's user (TimeLog records the key user as creator)", async () => {
    const creations = [
      ['create_task', { projectId: 1, name: 'Ny opgave' }],
      ['create_project', { templateId: 2, name: 'Nyt projekt', customerId: 3 }],
    ] as const;
    const none = upstream({ 'GET /api/v1/user': { body: list([KEY_USER]) } });
    for (const [tool, input] of creations) {
      expect(await none.gw.callTool(tool, input, asMette)).toMatchObject({ isError: true, actAsRefused: 'no_user' });
    }
    expect(writes(none.calls)).toEqual([]);

    // The person has a user, but the key is another user's: never created in the key user's name for her.
    const other = upstream({ ...USERS, 'GET /api/v1/user/me': { body: single(KEY_USER) } });
    for (const [tool, input] of creations) {
      const result = await other.gw.callTool(tool, input, asMette);
      expect(result).toMatchObject({ isError: true, content: [{ text: CREATED_BY_KEY_USER_ONLY }] });
      expect(result.actAsRefused).toBeUndefined();
    }
    expect(writes(other.calls)).toEqual([]);

    const own = upstream({
      ...USERS,
      'GET /api/v1/user/me': { body: single(METTE) },
      'POST /api/v1/task': { body: single({ TaskID: 12, Name: 'Ny opgave' }) },
    });
    const ok = await own.gw.callTool('create_task', { projectId: 1, name: 'Ny opgave' }, asMette);
    expect(ok.isError).toBeUndefined();
    expect(writes(own.calls).map(call => call.path)).toEqual(['/api/v1/task']);
  });

  it('without actAs every call runs as the key user, as before, with no lookup', async () => {
    const { gw, calls } = upstream({ 'POST /api/v1/time-registration': { body: single(REGISTRATION(1)) } });
    const result = await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2, employeeId: 8 }, { caller: 'p-1' });
    expect(result.isError).toBeUndefined();
    expect(calls.map(call => call.path)).toEqual(['/api/v1/time-registration']);
    expect(calls[0]?.body).toMatchObject({ UserID: 8 });
  });
});

describe('reads with actAs', () => {
  const period = { fromDate: '2026-11-01', toDate: '2026-11-30' };

  it("reads the time of a period only when the person is the key's own user", async () => {
    for (const tool of ['list_time_registrations', 'time_summary']) {
      const other = upstream({ ...USERS, 'GET /api/v1/user/me': { body: single(KEY_USER) } });
      const refused = await other.gw.callTool(tool, period, asMette);
      expect(refused).toMatchObject({ isError: true, content: [{ text: OWN_TIME_ONLY }] });
      expect(other.calls.some(call => call.path.includes('time-tracking-item'))).toBe(false);

      const self = upstream({
        ...USERS,
        'GET /api/v1/user/me': { body: single(METTE) },
        'GET /api/v1/time-tracking-item/get-by-date': { body: list([REGISTRATION(7)]) },
      });
      const ok = await self.gw.callTool(tool, period, asMette);
      expect(ok.isError).toBeUndefined();
    }
  });

  it("get_time_registration gives only the person's own registration", async () => {
    const theirs = upstream({ ...USERS, 'GET /api/v1/time-tracking-item/77': { body: single(REGISTRATION(8)) } });
    expect(await theirs.gw.callTool('get_time_registration', { timeRegistrationId: 77 }, asMette)).toMatchObject({
      isError: true,
      content: [{ text: NOT_OWN_REGISTRATION }],
    });
    const own = upstream({ ...USERS, 'GET /api/v1/time-tracking-item/77': { body: single(REGISTRATION(7)) } });
    expect((await own.gw.callTool('get_time_registration', { timeRegistrationId: 77 }, asMette)).isError).toBeUndefined();
  });

  it('other reads run as the key user, without a lookup', async () => {
    const { gw, calls } = upstream({ 'GET /api/v1/customer/3': { body: single({ CustomerID: 3, Name: 'Kunde' }) } });
    const result = await gw.callTool('get_customer', { customerId: 3 }, asMette);
    expect(result.isError).toBeUndefined();
    expect(calls.map(call => call.path)).toEqual(['/api/v1/customer/3']);
  });
});

describe('the catalog', () => {
  it('names the lookup of the person first in every write tool', () => {
    for (const entry of timelogToolCatalog.filter(tool => tool.riskLevel !== 'read')) {
      expect(entry.upstream[0], entry.name).toEqual({ access: 'read', method: 'GET', path: '/api/v1/user' });
    }
  });

  it('keeps actAsRefused only on an error result', async () => {
    const { gw } = upstream({ ...USERS, 'GET /api/v1/customer/3': { body: single({ CustomerID: 3 }) } });
    const result = await gw.callTool('get_customer', { customerId: 3 }, asMette);
    expect('actAsRefused' in result).toBe(false);
  });
});
