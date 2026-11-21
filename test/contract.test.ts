import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTimelogGateway } from '../src/gateway.js';
import { nestedFailuresAsStatus } from '../src/errors.js';
import { BASE } from './helpers.js';

/**
 * Contract tests: every tool against answers shaped as in TimeLog's REST API
 * documentation (TimeLog.REST.API.json in TimeLog's SDK, "Timelog Web API
 * version 1", and the TAFSingle/TAFList examples on api.timelog.com/rest).
 * The fields are the read models' own; amounts, hourly rates and cost prices
 * are included in the answers so the tests show they never reach a result.
 */

const KEY = 'pat-zzzz-yyyy-xxxx-wwww-1';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('TIMELOG_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const single = (properties: Record<string, unknown>, href = 'self') => ({
  Properties: properties,
  Links: [{ Href: `${BASE}/api/v1/${href}`, Rel: 'self' }],
});
const list = (entities: Array<Record<string, unknown>>, page = 1) => ({
  Properties: { TotalRecord: String(entities.length), TotalPage: '1', PageNumber: String(page) },
  Entities: entities.map(properties => ({ Properties: properties, Links: [] })),
  Links: [{ Href: `${BASE}/api/v1/list`, Rel: 'self' }],
});

const CUSTOMER = {
  CustomerID: 3,
  ID: '7c1f6d2a-0000-4000-8000-000000000003',
  Name: 'Nordlys Rådgivning ApS',
  No: 'K-1003',
  DefaultMileageDistance: 12,
  CustomerStatusID: 1,
  VATNo: 'DK12345678',
  OrganizationNo: '12345678',
};
const PROJECT = {
  ProjectID: 1,
  ID: '7c1f6d2a-0000-4000-8000-000000000001',
  Name: 'Ny hjemmeside',
  No: 'P-2026-01',
  ExpenseIsBillable: true,
  CustomerID: 3,
  Customer: CUSTOMER,
  ContactID: 4,
  Description: 'Design og udvikling',
  DepartmentID: 2,
  ProjectManagerID: 9,
  AccountManagerID: 10,
  PartnerID: 11,
  ProjectTypeID: 1,
  ProjectCategoryID: 1,
  BudgetWorkHours: 320,
  BudgetWorkAmount: 296000,
  StartDate: '2026-11-01T00:00:00',
  EndDate: '2027-02-28T00:00:00',
};
const TASK = {
  TaskID: 5,
  ID: '7c1f6d2a-0000-4000-8000-000000000005',
  Name: 'Design',
  No: 'T-1',
  IsFixedPrice: false,
  IsDefaultBillable: true,
  AdditionalTextIsRequired: false,
  ParentFullName: 'Ny hjemmeside',
  ProjectID: 1,
  Project: { ProjectID: 1, ID: 'x', Name: 'Ny hjemmeside', No: 'P-2026-01', ExpenseIsBillable: true, CustomerID: 3, MainContractId: 8 },
  ParentTaskID: 0,
  IsTravelTimeTask: false,
  IsFavourite: true,
  HourlyRate: 950,
};
const USER = {
  UserID: 9,
  ID: '7c1f6d2a-0000-4000-8000-000000000009',
  FirstName: 'Mette',
  LastName: 'Holm',
  Initials: 'MH',
  IsActive: true,
  UserType: 'Employee',
  LegalEntityID: 1,
  Email: 'mette@nordlys.example',
  CostPrice: 410,
  Salary: 42000,
};
const WORK = {
  CustomerID: 3,
  CustomerName: 'Nordlys Rådgivning ApS',
  CustomerNo: 'K-1003',
  ProjectID: 1,
  ProjectName: 'Ny hjemmeside',
  ProjectNo: 'P-2026-01',
  TaskID: 5,
  TaskName: 'Design',
  TaskFullName: 'Ny hjemmeside / Design',
  IsFixedPrice: false,
  TaskNo: 'T-1',
  TaskIsActive: true,
  AbsenceCodeID: 0,
  AbsenceName: null,
  AbsenceCode: null,
  AllocatedHour: 0,
  TimeRegistrationID: 77,
  EntityID: 1,
  EntityType: 1,
  UserID: 9,
  Created: '2026-11-03T08:00:00',
  LastModified: '2026-11-03T08:00:00',
  IsBillable: true,
  Date: '2026-11-03T00:00:00',
  Comment: 'Skitser',
  Hours: 2.5,
  AdditionalTextField: '',
  InvoiceStatus: false,
  TimeRegistrationApprovalStatus: 1,
  BillableHours: 2.5,
};
const ABSENCE = {
  ...WORK,
  TimeRegistrationID: 78,
  ProjectID: 0,
  ProjectName: null,
  TaskID: 0,
  TaskName: null,
  AbsenceCodeID: 12,
  AbsenceName: 'Sygdom',
  AbsenceCode: 'SYG',
  Comment: 'Influenza',
  Date: '2026-11-04T00:00:00',
  Hours: 7.4,
  BillableHours: 0,
  IsBillable: false,
};

type Route = { status?: number; body?: unknown };

function upstream(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; query: Record<string, string>; body?: unknown; auth?: string }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    const route = routes[`${method} ${path}`];
    if (!route) return Response.json({ Code: 404, Message: 'Not found' }, { status: 404 });
    return Response.json(route.body ?? {}, { status: route.status ?? 200 });
  });
  const gw = createTimelogGateway({
    apiKey: KEY,
    baseUrl: BASE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxAttempts: 1,
    policy: { enableWrites: true },
  });
  return { gw, calls };
}

const MONEY = /BudgetWorkAmount|HourlyRate|CostPrice|Salary|296000|42000|\b950\b|\b410\b/;

describe('reads, shaped as TimeLog answers', () => {
  it('check_connection reads /user/me with the token as a bearer token', async () => {
    const { gw, calls } = upstream({ 'GET /api/v1/user/me': { body: single(USER, 'user/me') } });
    const result = await gw.callTool('check_connection', {});
    expect(result.structuredContent).toEqual({
      connected: true,
      user: { UserID: 9, ID: USER.ID, FirstName: 'Mette', LastName: 'Holm', Initials: 'MH', IsActive: true, UserType: 'Employee', LegalEntityID: 1, Email: 'mette@nordlys.example' },
    });
    expect(calls[0]?.auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(result)).not.toMatch(MONEY);
  });

  it('list_projects lists active projects without amounts, and searches by name', async () => {
    const { gw, calls } = upstream({
      'GET /api/v1/project/get-all': { body: list([PROJECT]) },
      'GET /api/v1/project-header/search-for-time-tracking': { body: list([{ ...TASK.Project, Customer: CUSTOMER }]) },
    });
    const all = await gw.callTool('list_projects', { customerId: 3 });
    expect(calls[0]).toMatchObject({ path: '/api/v1/project/get-all', query: { customerID: '3', isActive: 'true', $page: '1', $pagesize: '50' } });
    expect(all.structuredContent).toMatchObject({ count: 1, totalRecords: 1, totalPages: 1, page: 1 });
    const project = (all.structuredContent as { projects: Array<Record<string, unknown>> }).projects[0]!;
    expect(project).toMatchObject({ ProjectID: 1, Name: 'Ny hjemmeside', BudgetWorkHours: 320, ProjectManagerID: 9 });
    expect(project).not.toHaveProperty('BudgetWorkAmount');
    expect(project.Customer).not.toHaveProperty('DefaultMileageDistance');

    const found = await gw.callTool('list_projects', { query: 'hjemmeside', includeInactive: true });
    expect(calls[1]).toMatchObject({
      path: '/api/v1/project-header/search-for-time-tracking',
      query: { searchText: 'hjemmeside', searchAll: 'true' },
    });
    expect((found.structuredContent as { projects: unknown[] }).projects).toEqual([
      { ProjectID: 1, ID: 'x', Name: 'Ny hjemmeside', No: 'P-2026-01', CustomerID: 3, Customer: expect.objectContaining({ Name: CUSTOMER.Name }) },
    ]);
    expect(JSON.stringify([all, found])).not.toMatch(MONEY);
  });

  it('list_projects with includeInactive asks for inactive projects', async () => {
    const { gw, calls } = upstream({ 'GET /api/v1/project/get-all': { body: list([]) } });
    await gw.callTool('list_projects', { includeInactive: true });
    expect(calls[0]?.query.isActive).toBe('false');
  });

  it('get_project reads the project and, on request, its tasks', async () => {
    const { gw, calls } = upstream({
      'GET /api/v1/project/1': { body: single(PROJECT) },
      'GET /api/v1/task': { body: list([TASK]) },
    });
    const result = await gw.callTool('get_project', { projectId: 1, includeTasks: true });
    expect(calls[1]).toMatchObject({ path: '/api/v1/task', query: { projectID: '1' } });
    const data = result.structuredContent as { project: Record<string, unknown>; tasks: Array<Record<string, unknown>> };
    expect(data.project.Name).toBe('Ny hjemmeside');
    expect(data.tasks[0]).toMatchObject({ TaskID: 5, Name: 'Design', Project: { ProjectID: 1, Name: 'Ny hjemmeside' } });
    expect(data.tasks[0]).not.toHaveProperty('IsFavourite');
    expect(data.tasks[0]?.Project).not.toHaveProperty('MainContractId');
    expect(JSON.stringify(result)).not.toMatch(MONEY);
  });

  it('list_project_templates lists templates', async () => {
    const { gw } = upstream({
      'GET /api/v1/project-template/get-all': {
        body: list([{ ProjectTemplateGuid: 'g', ProjectTemplateID: 2, ProjectTemplateName: 'Fastpris', ProjectTemplateDescription: 'Standard', IsActive: true }]),
      },
    });
    const result = await gw.callTool('list_project_templates', {});
    expect((result.structuredContent as { templates: unknown[] }).templates).toEqual([
      { ProjectTemplateID: 2, ProjectTemplateName: 'Fastpris', ProjectTemplateDescription: 'Standard', IsActive: true },
    ]);
  });

  it('list_tasks lists a project\'s tasks with a filter, or searches tasks without a project', async () => {
    const other = { ...TASK, TaskID: 6, Name: 'Udvikling', No: 'T-2' };
    const { gw, calls } = upstream({
      'GET /api/v1/task': { body: list([TASK, other]) },
      'GET /api/v1/task/search-for-time-tracking': { body: list([other]) },
    });
    const filtered = await gw.callTool('list_tasks', { projectId: 1, query: 'udvik' });
    expect((filtered.structuredContent as { tasks: Array<{ TaskID: number }> }).tasks.map(t => t.TaskID)).toEqual([6]);
    const searched = await gw.callTool('list_tasks', { query: 'udvikling' });
    expect(calls[1]).toMatchObject({ path: '/api/v1/task/search-for-time-tracking', query: { searchText: 'udvikling', searchAll: 'true' } });
    expect((searched.structuredContent as { tasks: unknown[] }).tasks).toHaveLength(1);
    const neither = await gw.callTool('list_tasks', {});
    expect(neither.isError).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify([filtered, searched])).not.toMatch(MONEY);
  });

  it('get_task, get_customer and get_employee read one object each', async () => {
    const { gw } = upstream({
      'GET /api/v1/task/5': { body: single(TASK) },
      'GET /api/v1/customer/3': { body: single(CUSTOMER) },
      'GET /api/v1/user/9': { body: single(USER) },
    });
    const taskResult = await gw.callTool('get_task', { taskId: 5 });
    const customerResult = await gw.callTool('get_customer', { customerId: 3 });
    const employeeResult = await gw.callTool('get_employee', { employeeId: 9 });
    expect(taskResult.structuredContent).toMatchObject({ task: { TaskID: 5, Name: 'Design' } });
    expect(customerResult.structuredContent).toEqual({
      customer: { CustomerID: 3, ID: CUSTOMER.ID, Name: CUSTOMER.Name, No: 'K-1003', CustomerStatusID: 1, VATNo: 'DK12345678', OrganizationNo: '12345678' },
    });
    expect(employeeResult.structuredContent).toMatchObject({ employee: { UserID: 9, Initials: 'MH' } });
    expect(JSON.stringify([taskResult, customerResult, employeeResult])).not.toMatch(MONEY);
  });

  it('list_customers lists or searches customers', async () => {
    const { gw, calls } = upstream({
      'GET /api/v1/customer': { body: list([CUSTOMER]) },
      'GET /api/v1/customer/search-for-time-tracking': { body: list([CUSTOMER]) },
    });
    await gw.callTool('list_customers', { page: 2, pageSize: 10 });
    await gw.callTool('list_customers', { query: 'Nordlys' });
    expect(calls.map(c => [c.path, c.query.$page, c.query.$pagesize, c.query.searchText])).toEqual([
      ['/api/v1/customer', '2', '10', undefined],
      ['/api/v1/customer/search-for-time-tracking', '1', '50', 'Nordlys'],
    ]);
  });

  it('list_employees leaves out inactive employees and filters by name, without salaries or cost prices', async () => {
    const inactive = { ...USER, UserID: 10, FirstName: 'Jonas', LastName: 'Berg', Initials: 'JB', IsActive: false };
    const { gw } = upstream({ 'GET /api/v1/user': { body: list([USER, inactive]) } });
    const active = await gw.callTool('list_employees', {});
    expect((active.structuredContent as { employees: Array<{ UserID: number }> }).employees.map(e => e.UserID)).toEqual([9]);
    const all = await gw.callTool('list_employees', { includeInactive: true, query: 'jonas' });
    expect((all.structuredContent as { employees: Array<{ UserID: number }> }).employees.map(e => e.UserID)).toEqual([10]);
    expect(JSON.stringify([active, all])).not.toMatch(MONEY);
  });

  it('list_time_registrations returns the token user\'s registrations and absence without its reason', async () => {
    const { gw, calls } = upstream({ 'GET /api/v1/time-tracking-item/get-by-date': { body: list([WORK, ABSENCE]) } });
    const result = await gw.callTool('list_time_registrations', { fromDate: '2026-11-02', toDate: '2026-11-06' });
    expect(calls[0]?.query).toEqual({ startDate: '2026-11-02', endDate: '2026-11-06', $page: '1', $pagesize: '500' });
    const data = result.structuredContent as { registrations: Array<Record<string, unknown>>; count: number };
    expect(data.count).toBe(2);
    expect(data.registrations[0]).toMatchObject({ TimeRegistrationID: 77, Hours: 2.5, TaskName: 'Design', Comment: 'Skitser' });
    expect(data.registrations[0]).not.toHaveProperty('InvoiceStatus');
    expect(data.registrations[1]).toEqual({
      TimeRegistrationID: 78,
      Date: '2026-11-04T00:00:00',
      Hours: 7.4,
      UserID: 9,
      TimeRegistrationApprovalStatus: 1,
      IsAbsence: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/Sygdom|SYG|Influenza/);
  });

  it('refuses a period that runs backwards or is longer than a year, without calling TimeLog', async () => {
    const { gw, calls } = upstream({});
    expect((await gw.callTool('time_summary', { fromDate: '2026-11-06', toDate: '2026-11-02' })).isError).toBe(true);
    expect((await gw.callTool('list_time_registrations', { fromDate: '2025-01-01', toDate: '2026-11-02' })).isError).toBe(true);
    expect((await gw.callTool('timesheet_status', { fromDate: '2026-13-01', toDate: '2026-11-02' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('get_time_registration reads one registration', async () => {
    const { gw, calls } = upstream({ 'GET /api/v1/time-tracking-item/78': { body: single(ABSENCE) } });
    const result = await gw.callTool('get_time_registration', { timeRegistrationId: 78 });
    expect(calls[0]?.path).toBe('/api/v1/time-tracking-item/78');
    expect(result.structuredContent).toMatchObject({ registration: { IsAbsence: true, Hours: 7.4 } });
    expect(JSON.stringify(result)).not.toMatch(/Sygdom|SYG|Influenza/);
  });

  it('time_summary sums hours by project, task and day, with absence as one sum', async () => {
    const more = { ...WORK, TimeRegistrationID: 79, TaskID: 6, TaskName: 'Udvikling', Hours: 4, BillableHours: 0, IsBillable: false };
    const { gw } = upstream({ 'GET /api/v1/time-tracking-item/get-by-date': { body: list([WORK, more, ABSENCE]) } });
    const result = await gw.callTool('time_summary', { fromDate: '2026-11-02', toDate: '2026-11-06' });
    expect(result.structuredContent).toEqual({
      fromDate: '2026-11-02',
      toDate: '2026-11-06',
      totalHours: 13.9,
      billableHours: 2.5,
      absenceHours: 7.4,
      registrations: 3,
      byProject: [{ ProjectID: 1, ProjectName: 'Ny hjemmeside', CustomerName: 'Nordlys Rådgivning ApS', hours: 6.5 }],
      byTask: [
        { TaskID: 6, TaskName: 'Udvikling', ProjectName: 'Ny hjemmeside', hours: 4 },
        { TaskID: 5, TaskName: 'Design', ProjectName: 'Ny hjemmeside', hours: 2.5 },
      ],
      byDay: [
        { date: '2026-11-03', hours: 6.5 },
        { date: '2026-11-04', hours: 7.4 },
      ],
    });
  });

  it('time_summary and list_time_registrations read every page of the period before they sum', async () => {
    const pageOne = { ...list([{ ...WORK, Hours: 2, BillableHours: 2 }]), Properties: { TotalRecord: '2', TotalPage: '2', PageNumber: '1' } };
    const pageTwo = { ...list([{ ...WORK, TimeRegistrationID: 80, Hours: 3, BillableHours: 0 }]), Properties: { TotalRecord: '2', TotalPage: '2', PageNumber: '2' } };
    const pages: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get('$page');
      pages.push(page ?? '');
      return Response.json(page === '2' ? pageTwo : pageOne);
    });
    const gw = createTimelogGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, maxAttempts: 1, policy: {} });
    const summary = await gw.callTool('time_summary', { fromDate: '2026-11-02', toDate: '2026-11-06' });
    expect(summary.structuredContent).toMatchObject({ totalHours: 5, billableHours: 2, registrations: 2 });
    expect(summary.structuredContent).not.toHaveProperty('incomplete');
    const listed = await gw.callTool('list_time_registrations', { fromDate: '2026-11-02', toDate: '2026-11-06' });
    expect(listed.structuredContent).toMatchObject({ count: 2 });
    expect(pages).toEqual(['1', '2', '1', '2']);
  });

  it('says a period is incomplete when TimeLog reports more pages than are read', async () => {
    const endless = { ...list([{ ...WORK, Hours: 1 }]), Properties: { TotalRecord: '99999', TotalPage: '9999', PageNumber: '1' } };
    const fetchImpl = vi.fn(async () => Response.json(endless));
    const gw = createTimelogGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, maxAttempts: 1, policy: {} });
    const summary = await gw.callTool('time_summary', { fromDate: '2026-01-01', toDate: '2026-12-31' });
    expect(summary.structuredContent).toMatchObject({ incomplete: true });
    expect(fetchImpl).toHaveBeenCalledTimes(40);
  });

  it('timesheet_status lists weekly status per employee', async () => {
    const { gw, calls } = upstream({
      'GET /api/v1/timesheet-status/weekly': {
        body: list([
          {
            Initials: 'MH',
            DisplayName: 'Mette Holm',
            EmployeeUserID: 9,
            AggregationType: 1,
            ShowSendEmailRequest: false,
            ManagerInitials: 'JB',
            ManagerDisplayName: 'Jonas Berg',
            EmployeeDepartmentName: 'Rådgivning',
            Details: [{ WeekNumber: 45, TimesheetStatus: 'Approved', StartDate: '2026-11-02T00:00:00', EndDate: '2026-11-08T00:00:00' }],
          },
        ]),
      },
    });
    const result = await gw.callTool('timesheet_status', { fromDate: '2026-11-02', toDate: '2026-11-30', departmentId: 2 });
    expect(calls[0]?.query).toEqual({ startDate: '2026-11-02', endDate: '2026-11-30', departmentId: '2' });
    expect((result.structuredContent as { employees: unknown[] }).employees).toEqual([
      {
        EmployeeUserID: 9,
        Initials: 'MH',
        DisplayName: 'Mette Holm',
        EmployeeDepartmentName: 'Rådgivning',
        ManagerInitials: 'JB',
        ManagerDisplayName: 'Jonas Berg',
        Weeks: [{ WeekNumber: 45, TimesheetStatus: 'Approved', StartDate: '2026-11-02T00:00:00', EndDate: '2026-11-08T00:00:00' }],
      },
    ]);
  });
});

describe('changes, shaped as TimeLog takes them', () => {
  it('register_time posts the registration, for the token user or another employee', async () => {
    const { gw, calls } = upstream({ 'POST /api/v1/time-registration': { body: {} } });
    const own = await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 1.5, comment: 'Møde' });
    expect(own.structuredContent).toEqual({ accepted: true, taskId: 5, date: '2026-11-03', hours: 1.5 });
    expect(calls[0]?.body).toEqual({ TaskID: 5, Date: '2026-11-03T00:00:00', Hours: 1.5, Comment: 'Møde' });
    await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 2, billable: false, employeeId: 10 });
    expect(calls[1]?.body).toEqual({ TaskID: 5, Date: '2026-11-03T00:00:00', Hours: 2, Billable: false, BillableHours: 0, UserID: 10 });
  });

  it('register_time refuses hours outside (0, 24] and a malformed day, without calling TimeLog', async () => {
    const { gw, calls } = upstream({});
    for (const input of [
      { taskId: 5, date: '2026-11-03', hours: 0 },
      { taskId: 5, date: '2026-11-03', hours: 25 },
      { taskId: 5, date: '3.11.2026', hours: 1 },
      { taskId: 0, date: '2026-11-03', hours: 1 },
    ]) {
      expect((await gw.callTool('register_time', input)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('update_time reads the registration and sends back every field it does not change', async () => {
    const { gw, calls } = upstream({
      'GET /api/v1/time-tracking-item/77': { body: single({ ...WORK, AdditionalTextField: 'Ekstra' }) },
      'POST /api/v1/time-registration/update-time': { body: {} },
    });
    const result = await gw.callTool('update_time', { timeRegistrationId: 77, hours: 3 });
    expect(result.structuredContent).toEqual({ accepted: true, timeRegistrationId: 77, hours: 3, date: '2026-11-03', taskId: 5 });
    expect(calls[1]?.body).toEqual({
      TimeRegistrationID: 77,
      TaskID: 5,
      Date: '2026-11-03T00:00:00',
      Hours: 3,
      Billable: true,
      BillableHours: 3,
      Comment: 'Skitser',
      AdditionalComment: 'Ekstra',
    });
  });

  it('update_time keeps the billable hours, the monthly period and the times when only the comment changes', async () => {
    const { gw, calls } = upstream({
      'GET /api/v1/time-tracking-item/77': {
        body: single({ ...WORK, BillableHours: 2, MonthlyPeriod: '2026-11', StartTime: '2026-11-03T08:00:00', EndTime: '2026-11-03T10:30:00' }),
      },
      'POST /api/v1/time-registration/update-time': { body: {} },
    });
    await gw.callTool('update_time', { timeRegistrationId: 77, comment: 'Rettet' });
    expect(calls[1]?.body).toEqual({
      TimeRegistrationID: 77,
      TaskID: 5,
      Date: '2026-11-03T00:00:00',
      Hours: 2.5,
      Billable: true,
      BillableHours: 2,
      Comment: 'Rettet',
      AdditionalComment: '',
      MonthlyPeriod: '2026-11',
      StartTime: '2026-11-03T08:00:00',
      EndTime: '2026-11-03T10:30:00',
    });
  });

  it('update_time does not change an absence and needs a field to change', async () => {
    const { gw, calls } = upstream({ 'GET /api/v1/time-tracking-item/78': { body: single(ABSENCE) } });
    const absence = await gw.callTool('update_time', { timeRegistrationId: 78, hours: 1 });
    expect(absence.isError).toBe(true);
    expect(JSON.stringify(absence)).not.toMatch(/Sygdom|Influenza/);
    const nothing = await gw.callTool('update_time', { timeRegistrationId: 78 });
    expect(nothing.isError).toBe(true);
    expect(calls.map(c => c.method)).toEqual(['GET']);
  });

  it('create_task posts a task or a sub-task, without prices', async () => {
    const { gw, calls } = upstream({ 'POST /api/v1/task': { body: {} }, 'POST /api/v1/task/create-sub-task': { body: {} } });
    const created = await gw.callTool('create_task', { projectId: 1, name: 'Test', budgetHours: 10, startDate: '2026-11-03' });
    expect(created.structuredContent).toEqual({ accepted: true, projectId: 1 });
    expect(calls[0]?.body).toEqual({ ProjectID: 1, TaskName: 'Test', StartDate: '2026-11-03T00:00:00', BudgetHours: 10 });
    await gw.callTool('create_task', { projectId: 1, name: 'Del', parentTaskId: 5 });
    expect(calls[1]).toMatchObject({ path: '/api/v1/task/create-sub-task', body: { ProjectID: 1, TaskName: 'Del', ParentTaskID: 5 } });
    expect((await gw.callTool('create_task', { projectId: 1, name: 'x', hourlyRate: 900 })).isError).toBe(true);
  });

  it('create_project creates a project from a template', async () => {
    const { gw, calls } = upstream({
      'POST /api/v1/project/create-from-template': {
        body: single({ ProjectID: 12, Name: 'Ny app', ProjectNo: 'P-12', CustomerID: 3, ProjectTemplateID: 2, CurrencyID: 1, InvoicingCustomerReferenceID: 4 }),
      },
    });
    const result = await gw.callTool('create_project', { templateId: 2, name: 'Ny app', customerId: 3, projectManagerId: 9 });
    expect(calls[0]?.body).toEqual({ ProjectTemplateID: 2, Name: 'Ny app', CustomerID: 3, ProjectManagerID: 9 });
    expect(result.structuredContent).toEqual({
      accepted: true,
      templateId: 2,
      customerId: 3,
      result: { ProjectID: 12, Name: 'Ny app', ProjectNo: 'P-12', CustomerID: 3, ProjectTemplateID: 2 },
    });
  });

  it('has no tool that changes, closes or deletes a project', async () => {
    const { gw, calls } = upstream({});
    for (const tool of ['update_project', 'delete_project', 'set_project_status']) {
      expect((await gw.callTool(tool, { projectId: 1 })).isError, tool).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('a refused change is an error with the status only, never TimeLog\'s text', async () => {
    const { gw } = upstream({
      'POST /api/v1/time-registration': { status: 422, body: { Code: 422, Message: 'Period is closed for jane@nordlys.example', Details: [] } },
    });
    const result = await gw.callTool('register_time', { taskId: 5, date: '2026-11-03', hours: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Timelog API request failed with HTTP 422/);
    expect(JSON.stringify(result)).not.toContain('jane@');
  });
});

describe('nestedFailuresAsStatus', () => {
  it('reduces failure lists inside a successful body to status-only text', () => {
    expect(nestedFailuresAsStatus({ metadata: { status: 401, error: 'Vendor' }, failures: [{ error: 'Vendor' }] })).toEqual({
      metadata: { status: 401, error: 'Timelog API request failed with HTTP 401' },
      failures: [{ message: 'Timelog API request failed.' }],
    });
  });
});
