import { nestedFailuresAsStatus, nestedFailureText } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { QueryValue, UpstreamClient } from './client.js';

/**
 * Calls to the TimeLog REST API (v1), relative to the account's address
 * (https://app<n>.timelog.com/<account>). Every caller-supplied path segment
 * goes through encodePathParam.
 *
 * TimeLog wraps a single object as TAFSingle ({ Properties, Links }) and a
 * list as TAFList ({ Properties: { TotalRecord, TotalPage, PageNumber },
 * Entities: [{ Properties }], Links }). Results are unwrapped and every
 * object is reduced to an allow-list of fields: no amounts, hourly rates,
 * cost prices or payment details reach a result, and absence registrations
 * are returned without their absence code, name or comment (an absence
 * reason can be a health matter).
 */

export const API = '/api/v1';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The Properties of a TAFSingle, or the object itself. */
export function unwrapSingle(body: unknown): unknown {
  const value = nestedFailuresAsStatus(body);
  if (isObject(value) && isObject(value.Properties) && !Array.isArray(value.Entities)) {
    return value.Properties;
  }
  return value;
}

export interface Page {
  totalRecords?: number;
  totalPages?: number;
  page?: number;
}

/** The entities of a TAFList (each one's Properties) and its paging, or a plain array. */
export function unwrapList(body: unknown): { items: unknown[]; paging: Page } {
  const value = nestedFailuresAsStatus(body);
  if (Array.isArray(value)) {
    return { items: value.map(entityProperties), paging: {} };
  }
  if (isObject(value) && Array.isArray(value.Entities)) {
    const properties = isObject(value.Properties) ? value.Properties : {};
    const paging: Page = {};
    const total = numberOf(properties.TotalRecord);
    const pages = numberOf(properties.TotalPage);
    const page = numberOf(properties.PageNumber);
    if (total !== undefined) paging.totalRecords = total;
    if (pages !== undefined) paging.totalPages = pages;
    if (page !== undefined) paging.page = page;
    return { items: value.Entities.map(entityProperties), paging };
  }
  if (isObject(value) && isObject(value.Properties)) {
    return { items: [value.Properties], paging: {} };
  }
  return { items: [], paging: {} };
}

function entityProperties(entity: unknown): unknown {
  return isObject(entity) && isObject(entity.Properties) ? entity.Properties : entity;
}

function numberOf(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Only the listed fields; a nested object is reduced by its own list. */
function pick(value: unknown, fields: readonly string[], nested: Readonly<Record<string, readonly string[]>> = {}): Json | undefined {
  const source = entityProperties(value);
  if (!isObject(source)) return undefined;
  const out: Json = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const inner = source[field];
    if (inner === undefined) continue;
    const list = nested[field];
    if (list) {
      const reduced = inner === null ? null : pick(inner, list);
      if (reduced !== undefined) out[field] = reduced;
    } else if (inner === null || typeof inner !== 'object') {
      out[field] = inner;
    }
  }
  return out;
}

// Allow-lists per object, from the read models in TimeLog's Swagger (Timelog Web API version 1).
export const CUSTOMER_FIELDS = ['CustomerID', 'ID', 'Name', 'No', 'CustomerStatusID', 'VATNo', 'OrganizationNo'] as const;
const PROJECT_HEADER_FIELDS = ['ProjectID', 'ID', 'Name', 'No', 'CustomerID', 'Customer'] as const;
export const PROJECT_FIELDS = [
  'ProjectID',
  'ID',
  'Name',
  'No',
  'CustomerID',
  'Customer',
  'Description',
  'DepartmentID',
  'ProjectManagerID',
  'AccountManagerID',
  'PartnerID',
  'ProjectTypeID',
  'ProjectCategoryID',
  'BudgetWorkHours',
  'StartDate',
  'EndDate',
] as const;
export const TASK_FIELDS = [
  'TaskID',
  'ID',
  'Name',
  'No',
  'ParentFullName',
  'ProjectID',
  'Project',
  'ParentTaskID',
  'IsDefaultBillable',
  'IsFixedPrice',
  'AdditionalTextIsRequired',
  'IsTravelTimeTask',
] as const;
export const EMPLOYEE_FIELDS = ['UserID', 'ID', 'FirstName', 'LastName', 'Initials', 'IsActive', 'UserType', 'LegalEntityID', 'Email'] as const;
const TEMPLATE_FIELDS = ['ProjectTemplateID', 'ProjectTemplateName', 'ProjectTemplateDescription', 'IsActive'] as const;
const TIME_FIELDS = [
  'TimeRegistrationID',
  'Date',
  'Hours',
  'BillableHours',
  'IsBillable',
  'Comment',
  'AdditionalTextField',
  'CustomerID',
  'CustomerName',
  'CustomerNo',
  'ProjectID',
  'ProjectName',
  'ProjectNo',
  'TaskID',
  'TaskName',
  'TaskFullName',
  'TaskNo',
  'UserID',
  'TimeRegistrationApprovalStatus',
  'StartTime',
  'EndTime',
  'Created',
  'LastModified',
] as const;
const TIMESHEET_FIELDS = [
  'EmployeeUserID',
  'Initials',
  'DisplayName',
  'EmployeeDepartmentName',
  'ManagerInitials',
  'ManagerDisplayName',
] as const;
const TIMESHEET_WEEK_FIELDS = ['WeekNumber', 'TimesheetStatus', 'StartDate', 'EndDate'] as const;

const customer = (value: unknown) => pick(value, CUSTOMER_FIELDS);
const projectHeader = (value: unknown) => pick(value, PROJECT_HEADER_FIELDS, { Customer: CUSTOMER_FIELDS });
export const project = (value: unknown) => pick(value, PROJECT_FIELDS, { Customer: CUSTOMER_FIELDS });
export const task = (value: unknown) =>
  pick(value, TASK_FIELDS, { Project: PROJECT_HEADER_FIELDS }) as Json | undefined;
const employee = (value: unknown) => pick(value, EMPLOYEE_FIELDS);
const template = (value: unknown) => pick(value, TEMPLATE_FIELDS);

/** A time registration; an absence is marked as one, without its code, name or comment. */
export function timeRegistration(value: unknown): Json | undefined {
  const source = entityProperties(value);
  if (!isObject(source)) return undefined;
  const absence = typeof source.AbsenceCodeID === 'number' && source.AbsenceCodeID > 0;
  if (absence) {
    const reduced = pick(source, ['TimeRegistrationID', 'Date', 'Hours', 'UserID', 'TimeRegistrationApprovalStatus', 'StartTime', 'EndTime']);
    return { ...reduced, IsAbsence: true };
  }
  return pick(source, TIME_FIELDS);
}

function timesheet(value: unknown): Json | undefined {
  const source = entityProperties(value);
  if (!isObject(source)) return undefined;
  const out = pick(source, TIMESHEET_FIELDS) ?? {};
  if (Array.isArray(source.Details)) {
    out.Weeks = source.Details.map(week => pick(week, TIMESHEET_WEEK_FIELDS)).filter(isObject);
  }
  return out;
}

function reduceAll(items: unknown[], reduce: (value: unknown) => Json | undefined): Json[] {
  return items.map(reduce).filter(isObject);
}

export interface Paging {
  page?: number;
  pageSize?: number;
}

function pagingQuery(input: Paging, defaultSize = 50): Record<string, QueryValue> {
  return { $page: input.page ?? 1, $pagesize: input.pageSize ?? defaultSize };
}

function listResult(key: string, items: Json[], paging: Page) {
  return { [key]: items, count: items.length, ...paging };
}

function textMatch(query: string | undefined, ...values: unknown[]): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase('da');
  return values.some(value => typeof value === 'string' && value.toLocaleLowerCase('da').includes(needle));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function checkConnection(client: UpstreamClient): Promise<unknown> {
  const me = employee(unwrapSingle(await client.get(`${API}/user/me`)));
  return { connected: true, user: me ?? null };
}

export async function listProjects(
  client: UpstreamClient,
  input: Paging & { query?: string; customerId?: number; includeInactive?: boolean },
): Promise<unknown> {
  if (input.query) {
    // Projects whose name or number matches, among those time can be registered on (searchAll: not only recent ones).
    const { items, paging } = unwrapList(
      await client.get(`${API}/project-header/search-for-time-tracking`, {
        searchText: input.query,
        searchAll: true,
        ...pagingQuery(input),
      }),
    );
    const projects = reduceAll(items, projectHeader).filter(
      p => input.customerId === undefined || p.CustomerID === input.customerId,
    );
    return listResult('projects', projects, paging);
  }
  const { items, paging } = unwrapList(
    await client.get(`${API}/project/get-all`, {
      customerID: input.customerId,
      isActive: input.includeInactive ? false : true,
      ...pagingQuery(input),
    }),
  );
  return listResult('projects', reduceAll(items, project), paging);
}

export async function getProject(client: UpstreamClient, input: { projectId: number; includeTasks?: boolean }): Promise<unknown> {
  const id = encodePathParam(input.projectId, 'projectId');
  const found = project(unwrapSingle(await client.get(`${API}/project/${id}`))) ?? null;
  if (!input.includeTasks) {
    return { project: found };
  }
  // A combined read: the project is returned even when its tasks cannot be read; the failure is a status only.
  const tasks = await client.get(`${API}/task`, { projectID: input.projectId, $page: 1, $pagesize: 500 }).then(
    body => reduceAll(unwrapList(body).items, task),
    (error: unknown) => ({ error: nestedFailureText(error) }),
  );
  return { project: found, tasks };
}

export async function listProjectTemplates(client: UpstreamClient): Promise<unknown> {
  const { items, paging } = unwrapList(await client.get(`${API}/project-template/get-all`));
  return listResult('templates', reduceAll(items, template), paging);
}

export async function listTasks(
  client: UpstreamClient,
  input: Paging & { projectId?: number; query?: string },
): Promise<unknown> {
  if (input.projectId !== undefined) {
    const { items, paging } = unwrapList(await client.get(`${API}/task`, { projectID: input.projectId, ...pagingQuery(input, 100) }));
    const tasks = reduceAll(items, task).filter(t => textMatch(input.query, t.Name, t.No, t.ParentFullName));
    return listResult('tasks', tasks, paging);
  }
  // Without a project: the tasks the token's user can register time on whose name or number matches.
  const { items, paging } = unwrapList(
    await client.get(`${API}/task/search-for-time-tracking`, { searchText: input.query, searchAll: true, ...pagingQuery(input) }),
  );
  return listResult('tasks', reduceAll(items, task), paging);
}

export async function getTask(client: UpstreamClient, input: { taskId: number }): Promise<unknown> {
  const id = encodePathParam(input.taskId, 'taskId');
  return { task: task(unwrapSingle(await client.get(`${API}/task/${id}`))) ?? null };
}

export async function listCustomers(client: UpstreamClient, input: Paging & { query?: string }): Promise<unknown> {
  if (input.query) {
    const { items, paging } = unwrapList(
      await client.get(`${API}/customer/search-for-time-tracking`, { searchText: input.query, searchAll: true, ...pagingQuery(input) }),
    );
    return listResult('customers', reduceAll(items, customer), paging);
  }
  const { items, paging } = unwrapList(await client.get(`${API}/customer`, pagingQuery(input)));
  return listResult('customers', reduceAll(items, customer), paging);
}

export async function getCustomer(client: UpstreamClient, input: { customerId: number }): Promise<unknown> {
  const id = encodePathParam(input.customerId, 'customerId');
  return { customer: customer(unwrapSingle(await client.get(`${API}/customer/${id}`))) ?? null };
}

export async function listEmployees(
  client: UpstreamClient,
  input: Paging & { query?: string; includeInactive?: boolean },
): Promise<unknown> {
  const { items, paging } = unwrapList(await client.get(`${API}/user`, pagingQuery(input, input.query ? 500 : 50)));
  const employees = reduceAll(items, employee).filter(
    e =>
      (input.includeInactive || e.IsActive !== false) &&
      textMatch(input.query, e.FirstName, e.LastName, e.Initials, `${String(e.FirstName ?? '')} ${String(e.LastName ?? '')}`),
  );
  return listResult('employees', employees, paging);
}

export async function getEmployee(client: UpstreamClient, input: { employeeId: number }): Promise<unknown> {
  const id = encodePathParam(input.employeeId, 'employeeId');
  return { employee: employee(unwrapSingle(await client.get(`${API}/user/${id}`))) ?? null };
}

export interface Period {
  fromDate: string;
  toDate: string;
}

/** Pages of 500 read for a period; a year of one person's registrations fits well within this. */
const PERIOD_PAGE_SIZE = 500;
const MAX_PERIOD_PAGES = 40;

/**
 * Every registration of the token's user in a period: all pages of the TAFList, so a total is never taken from the
 * first page only. `complete` is false only when TimeLog reports more pages than MAX_PERIOD_PAGES.
 */
async function ownRegistrations(client: UpstreamClient, input: Period): Promise<{ registrations: Json[]; complete: boolean }> {
  const registrations: Json[] = [];
  for (let page = 1; page <= MAX_PERIOD_PAGES; page += 1) {
    const { items, paging } = unwrapList(
      await client.get(`${API}/time-tracking-item/get-by-date`, {
        startDate: input.fromDate,
        endDate: input.toDate,
        $page: page,
        $pagesize: PERIOD_PAGE_SIZE,
      }),
    );
    registrations.push(...reduceAll(items, timeRegistration));
    // Without paging information (a plain list) or on the last page, the period is complete.
    const pages = paging.totalPages;
    if (pages === undefined || page >= pages || items.length === 0) return { registrations, complete: true };
  }
  return { registrations, complete: false };
}

export async function listTimeRegistrations(client: UpstreamClient, input: Period): Promise<unknown> {
  const { registrations, complete } = await ownRegistrations(client, input);
  return { fromDate: input.fromDate, toDate: input.toDate, registrations, count: registrations.length, ...(complete ? {} : { incomplete: true }) };
}

export async function getTimeRegistration(client: UpstreamClient, input: { timeRegistrationId: number }): Promise<unknown> {
  const id = encodePathParam(input.timeRegistrationId, 'timeRegistrationId');
  return { registration: timeRegistration(unwrapSingle(await client.get(`${API}/time-tracking-item/${id}`))) ?? null };
}

function hoursOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Hours of the token's user in a period: in total, billable, by project, by task and by day; absence as one sum. */
export async function timeSummary(client: UpstreamClient, input: Period): Promise<unknown> {
  const { registrations, complete } = await ownRegistrations(client, input);
  let total = 0;
  let billable = 0;
  let absence = 0;
  const byProject = new Map<string, { ProjectID: unknown; ProjectName: unknown; CustomerName: unknown; hours: number }>();
  const byTask = new Map<string, { TaskID: unknown; TaskName: unknown; ProjectName: unknown; hours: number }>();
  const byDay = new Map<string, number>();
  for (const r of registrations) {
    const hours = hoursOf(r.Hours);
    total += hours;
    const day = typeof r.Date === 'string' ? r.Date.slice(0, 10) : 'unknown';
    byDay.set(day, (byDay.get(day) ?? 0) + hours);
    if (r.IsAbsence === true) {
      absence += hours;
      continue;
    }
    billable += hoursOf(r.BillableHours);
    const projectKey = String(r.ProjectID ?? 'none');
    const p = byProject.get(projectKey) ?? { ProjectID: r.ProjectID, ProjectName: r.ProjectName, CustomerName: r.CustomerName, hours: 0 };
    p.hours += hours;
    byProject.set(projectKey, p);
    const taskKey = String(r.TaskID ?? 'none');
    const t = byTask.get(taskKey) ?? { TaskID: r.TaskID, TaskName: r.TaskName, ProjectName: r.ProjectName, hours: 0 };
    t.hours += hours;
    byTask.set(taskKey, t);
  }
  const sorted = <T extends { hours: number }>(values: Iterable<T>) =>
    [...values].sort((a, b) => b.hours - a.hours).map(v => ({ ...v, hours: round2(v.hours) }));
  return {
    fromDate: input.fromDate,
    toDate: input.toDate,
    totalHours: round2(total),
    billableHours: round2(billable),
    absenceHours: round2(absence),
    registrations: registrations.length,
    byProject: sorted(byProject.values()),
    byTask: sorted(byTask.values()),
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, hours]) => ({ date, hours: round2(hours) })),
    ...(complete ? {} : { incomplete: true }),
  };
}

export async function timesheetStatus(
  client: UpstreamClient,
  input: Period & { employeeId?: number; departmentId?: number },
): Promise<unknown> {
  const { items, paging } = unwrapList(
    await client.get(`${API}/timesheet-status/weekly`, {
      startDate: input.fromDate,
      endDate: input.toDate,
      userId: input.employeeId,
      departmentId: input.departmentId,
    }),
  );
  return { fromDate: input.fromDate, toDate: input.toDate, ...listResult('employees', reduceAll(items, timesheet), paging) };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** A date as TimeLog's API takes it: midnight of that day, without a zone. */
function dateTime(date: string): string {
  return `${date}T00:00:00`;
}

/** The answer to a change: TimeLog's own object when it sends one (reduced), else only that it was accepted. */
function changeResult(body: unknown, reduce: (value: unknown) => Json | undefined, extra: Json = {}): unknown {
  const value = unwrapSingle(body);
  const reduced = isObject(value) ? reduce(value) : undefined;
  return { accepted: true, ...extra, ...(reduced && Object.keys(reduced).length > 0 ? { result: reduced } : {}) };
}

export interface RegisterTimeInput {
  taskId: number;
  date: string;
  hours: number;
  comment?: string;
  billable?: boolean;
  employeeId?: number;
}

export async function registerTime(client: UpstreamClient, input: RegisterTimeInput): Promise<unknown> {
  const body: Json = { TaskID: input.taskId, Date: dateTime(input.date), Hours: input.hours };
  if (input.comment !== undefined) body.Comment = input.comment;
  if (input.billable !== undefined) {
    body.Billable = input.billable;
    body.BillableHours = input.billable ? input.hours : 0;
  }
  // Time for another employee: TimeLog decides whether the token's user may register it.
  if (input.employeeId !== undefined) body.UserID = input.employeeId;
  return changeResult(await client.post(`${API}/time-registration`, body), timeRegistration, {
    taskId: input.taskId,
    date: input.date,
    hours: input.hours,
  });
}

export interface UpdateTimeInput {
  timeRegistrationId: number;
  hours?: number;
  date?: string;
  taskId?: number;
  comment?: string;
  billable?: boolean;
}

/**
 * Correct a registration. TimeLog's update replaces the registration's time
 * fields, so the registration is read first and every field not being
 * changed is sent back as it was.
 */
export async function updateTime(client: UpstreamClient, input: UpdateTimeInput): Promise<unknown> {
  const id = encodePathParam(input.timeRegistrationId, 'timeRegistrationId');
  const current = unwrapSingle(await client.get(`${API}/time-tracking-item/${id}`));
  if (!isObject(current)) {
    throw new Error('The time registration could not be read; nothing was changed.');
  }
  if (typeof current.AbsenceCodeID === 'number' && current.AbsenceCodeID > 0) {
    throw new Error('This is an absence registration; it cannot be changed with this tool. Nothing was changed.');
  }
  const hours = input.hours ?? hoursOf(current.Hours);
  const wasBillable = current.IsBillable === true;
  const billable = input.billable ?? wasBillable;
  const currentBillableHours = hoursOf(current.BillableHours);
  const billableHours = !billable ? 0 : input.hours !== undefined || input.billable !== undefined ? hours : currentBillableHours;
  const currentDate = typeof current.Date === 'string' ? current.Date.slice(0, 10) : undefined;
  const date = input.date ?? currentDate;
  const taskId = input.taskId ?? current.TaskID;
  if (date === undefined || typeof taskId !== 'number') {
    throw new Error('The time registration is missing its date or task; nothing was changed.');
  }
  const body: Json = {
    TimeRegistrationID: input.timeRegistrationId,
    TaskID: taskId,
    Date: dateTime(date),
    Hours: hours,
    Billable: billable,
    BillableHours: billableHours,
    Comment: input.comment ?? (typeof current.Comment === 'string' ? current.Comment : ''),
  };
  if (typeof current.AdditionalTextField === 'string') body.AdditionalComment = current.AdditionalTextField;
  if (typeof current.MonthlyPeriod === 'string') body.MonthlyPeriod = current.MonthlyPeriod;
  if (typeof current.StartTime === 'string' && input.hours === undefined) body.StartTime = current.StartTime;
  if (typeof current.EndTime === 'string' && input.hours === undefined) body.EndTime = current.EndTime;
  return changeResult(await client.post(`${API}/time-registration/update-time`, body), timeRegistration, {
    timeRegistrationId: input.timeRegistrationId,
    hours,
    date,
    taskId,
  });
}

export interface CreateTaskInput {
  projectId: number;
  name: string;
  taskNo?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  budgetHours?: number;
  parentTaskId?: number;
  isBillable?: boolean;
  taskTypeId?: number;
}

export async function createTask(client: UpstreamClient, input: CreateTaskInput): Promise<unknown> {
  const body: Json = { ProjectID: input.projectId, TaskName: input.name };
  if (input.taskNo !== undefined) body.TaskNo = input.taskNo;
  if (input.description !== undefined) body.Description = input.description;
  if (input.startDate !== undefined) body.StartDate = dateTime(input.startDate);
  if (input.endDate !== undefined) body.EndDate = dateTime(input.endDate);
  if (input.budgetHours !== undefined) body.BudgetHours = input.budgetHours;
  if (input.isBillable !== undefined) body.IsBillable = input.isBillable;
  if (input.taskTypeId !== undefined) body.TaskTypeID = input.taskTypeId;
  const path = input.parentTaskId === undefined ? `${API}/task` : `${API}/task/create-sub-task`;
  if (input.parentTaskId !== undefined) body.ParentTaskID = input.parentTaskId;
  return changeResult(await client.post(path, body), task, { projectId: input.projectId });
}

export interface CreateProjectInput {
  templateId: number;
  name: string;
  customerId: number;
  projectNo?: string;
  description?: string;
  projectManagerId?: number;
  startDate?: string;
  endDate?: string;
}

const CREATED_PROJECT_FIELDS = ['ProjectID', 'Name', 'ProjectNo', 'CustomerID', 'ProjectTemplateID', 'ProjectManagerID', 'ProjectStartDate', 'ProjectEndDate'] as const;

export async function createProject(client: UpstreamClient, input: CreateProjectInput): Promise<unknown> {
  const body: Json = { ProjectTemplateID: input.templateId, Name: input.name, CustomerID: input.customerId };
  if (input.projectNo !== undefined) body.ProjectNo = input.projectNo;
  if (input.description !== undefined) body.Description = input.description;
  if (input.projectManagerId !== undefined) body.ProjectManagerID = input.projectManagerId;
  if (input.startDate !== undefined) body.ProjectStartDate = dateTime(input.startDate);
  if (input.endDate !== undefined) body.ProjectEndDate = dateTime(input.endDate);
  return changeResult(
    await client.post(`${API}/project/create-from-template`, body),
    value => pick(value, CREATED_PROJECT_FIELDS),
    { templateId: input.templateId, customerId: input.customerId },
  );
}
