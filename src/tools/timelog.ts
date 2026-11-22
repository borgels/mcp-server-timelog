import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  APPEND_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  UPDATE_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
} from '../timelog/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../timelog/audit.js';
import { readOnlyClient, type UpstreamClient } from '../timelog/client.js';
import { formatUnknownError, type SecretRedactor } from '../errors.js';
import * as api from '../timelog/api.js';
import { assertCreatorIsPerson, assertOwnTimeReadable, NOT_OWN_REGISTRATION, OTHER_EMPLOYEE, personUserId } from '../timelog/act-as-user.js';
import type { ActAs } from '../act-as.js';
import { checkInputPolicy, checkToolPolicy, isToolDisabled, redactInScope, runInCallScope, validatePolicyConfig } from '../timelog/policy.js';

/** TimeLog's identifiers are 32-bit integers. */
const idSchema = z.number().int().min(1).max(2_147_483_647);
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const dateSchema = z.string().regex(DATE, 'Use YYYY-MM-DD.');
const querySchema = z.string().trim().min(1).max(200);
const pageShape = {
  page: z.number().int().min(1).max(10_000).optional().describe('Page number, from 1. Default 1.'),
  pageSize: z.number().int().min(1).max(500).optional().describe('Results per page, at most 500. Default 50.'),
};
/** Hours in one registration: more than 0 and at most 24, in hundredths. */
const hoursSchema = z.number().gt(0).max(24).multipleOf(0.01);
const MAX_PERIOD_DAYS = 366;

/** The lookup of the person in actAs (src/timelog/act-as-user.ts), first in every tool that acts as them. */
const FIND_PERSON: UpstreamOperation = { access: 'read', method: 'GET', path: '/api/v1/user' };
/** The key's own user, compared with the person before a period read (TimeLog reads time only for the key's user). */
const KEY_USER: UpstreamOperation = { access: 'read', method: 'GET', path: '/api/v1/user/me' };

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** A period of at most a year, from fromDate to toDate (both included). */
function periodShape() {
  return {
    fromDate: dateSchema.describe('First day, YYYY-MM-DD.'),
    toDate: dateSchema.describe('Last day, YYYY-MM-DD (at most 366 days after fromDate).'),
  };
}

function checkPeriod(input: { fromDate: string; toDate: string }): void {
  const days = daysBetween(input.fromDate, input.toDate);
  if (!(days >= 0 && days <= MAX_PERIOD_DAYS)) {
    throw new Error('toDate must be on or after fromDate and at most 366 days later.');
  }
}

type ToolAnnotations =
  | typeof READ_TOOL_ANNOTATIONS
  | typeof WRITE_TOOL_ANNOTATIONS
  | typeof APPEND_TOOL_ANNOTATIONS
  | typeof UPDATE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the base URL (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PUT';
  path: string;
}

/** A client that carries the redactor of its instance (TimelogClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`timelog_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /**
   * True when the tool can read more than its name says: anything in the
   * system, chosen by the input (a generic get-by-path, a raw query).
   * Published as `broad` in the gateway catalog, so a host that grants tools
   * per role gives it only to roles that may read everything. Default false.
   */
  broad?: boolean;
  /**
   * Read-only tools (readOnlyHint) receive a client view that refuses
   * non-GET requests, so a mis-annotated tool cannot write.
   */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

export const TIMELOG_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'timelog_check_connection',
    title: 'Check Connection (TimeLog)',
    description: "Check that the token works and show which TimeLog user it belongs to. The token has that user's rights.",
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Connection checked.',
    upstream: [{ access: 'read', method: 'GET', path: '/api/v1/user/me' }],
    handler: async client => api.checkConnection(client),
  }),
  defineTool({
    name: 'timelog_list_projects',
    title: 'List Projects (TimeLog)',
    description:
      'List active projects with customer, project manager, budgeted hours and dates. With query: projects whose name or number matches. includeInactive lists inactive projects instead. No amounts.',
    inputShape: {
      query: querySchema.optional().describe('Part of the project name or number.'),
      customerId: idSchema.optional().describe('Only projects for this customer (CustomerID).'),
      includeInactive: z.boolean().optional().describe('List inactive projects instead of active ones.'),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed projects.',
    upstream: [
      { access: 'read', method: 'GET', path: '/api/v1/project/get-all' },
      { access: 'read', method: 'GET', path: '/api/v1/project-header/search-for-time-tracking' },
    ],
    handler: async (client, input) => api.listProjects(client, input),
  }),
  defineTool({
    name: 'timelog_get_project',
    title: 'Get Project (TimeLog)',
    description:
      'Fetch one project by its ProjectID, optionally with its tasks. A failed task read is reported in the result. No amounts.',
    inputShape: {
      projectId: idSchema.describe('ProjectID.'),
      includeTasks: z.boolean().optional().describe("Also list the project's tasks."),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched project.',
    upstream: [
      { access: 'read', method: 'GET', path: '/api/v1/project/{projectId}' },
      { access: 'read', method: 'GET', path: '/api/v1/task' },
    ],
    handler: async (client, input) => api.getProject(client, input),
  }),
  defineTool({
    name: 'timelog_list_project_templates',
    title: 'List Project Templates (TimeLog)',
    description: 'List the project templates a new project can be created from.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed project templates.',
    upstream: [{ access: 'read', method: 'GET', path: '/api/v1/project-template/get-all' }],
    handler: async client => api.listProjectTemplates(client),
  }),
  defineTool({
    name: 'timelog_list_tasks',
    title: 'List Tasks (TimeLog)',
    description:
      'List the tasks of a project (projectId), optionally filtered by query. Without projectId, query is required and finds tasks time can be registered on by name or number.',
    inputShape: {
      projectId: idSchema.optional().describe('ProjectID.'),
      query: querySchema.optional().describe('Part of the task name or number. Required without projectId.'),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed tasks.',
    upstream: [
      { access: 'read', method: 'GET', path: '/api/v1/task' },
      { access: 'read', method: 'GET', path: '/api/v1/task/search-for-time-tracking' },
    ],
    handler: async (client, input) => {
      if (input.projectId === undefined && input.query === undefined) {
        throw new Error('Give projectId or query.');
      }
      return api.listTasks(client, input);
    },
  }),
  defineTool({
    name: 'timelog_get_task',
    title: 'Get Task (TimeLog)',
    description: 'Fetch one task by its TaskID, with its project.',
    inputShape: { taskId: idSchema.describe('TaskID.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched task.',
    upstream: [{ access: 'read', method: 'GET', path: '/api/v1/task/{taskId}' }],
    handler: async (client, input) => api.getTask(client, input),
  }),
  defineTool({
    name: 'timelog_list_customers',
    title: 'List Customers (TimeLog)',
    description: 'List customers with number, VAT number and status. With query: customers whose name or number matches.',
    inputShape: {
      query: querySchema.optional().describe('Part of the customer name or number.'),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed customers.',
    upstream: [
      { access: 'read', method: 'GET', path: '/api/v1/customer' },
      { access: 'read', method: 'GET', path: '/api/v1/customer/search-for-time-tracking' },
    ],
    handler: async (client, input) => api.listCustomers(client, input),
  }),
  defineTool({
    name: 'timelog_get_customer',
    title: 'Get Customer (TimeLog)',
    description: 'Fetch one customer by its CustomerID.',
    inputShape: { customerId: idSchema.describe('CustomerID.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched customer.',
    upstream: [{ access: 'read', method: 'GET', path: '/api/v1/customer/{customerId}' }],
    handler: async (client, input) => api.getCustomer(client, input),
  }),
  defineTool({
    name: 'timelog_list_employees',
    title: 'List Employees (TimeLog)',
    description:
      'List active employees (users) with name, initials, user type and work email. With query: by name or initials. No salaries, hourly rates or cost prices.',
    inputShape: {
      query: querySchema.optional().describe('Part of the name or the initials.'),
      includeInactive: z.boolean().optional().describe('Also list inactive employees.'),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed employees.',
    upstream: [{ access: 'read', method: 'GET', path: '/api/v1/user' }],
    handler: async (client, input) => api.listEmployees(client, input),
  }),
  defineTool({
    name: 'timelog_get_employee',
    title: 'Get Employee (TimeLog)',
    description: 'Fetch one employee (user) by UserID. No salaries, hourly rates or cost prices.',
    inputShape: { employeeId: idSchema.describe('UserID.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched employee.',
    upstream: [{ access: 'read', method: 'GET', path: '/api/v1/user/{employeeId}' }],
    handler: async (client, input) => api.getEmployee(client, input),
  }),
  defineTool({
    name: 'timelog_list_time_registrations',
    title: 'List Time Registrations (TimeLog)',
    description:
      "List the time registrations of the token's user in a period: date, hours, billable hours, customer, project, task, comment and approval status. Absence is shown as absence, without its reason. Acting as a person, only when the person is the token's user (TimeLog reads time only for the token's user).",
    inputShape: periodShape(),
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed time registrations.',
    upstream: [FIND_PERSON, KEY_USER, { access: 'read', method: 'GET', path: '/api/v1/time-tracking-item/get-by-date' }],
    handler: async (client, input) => {
      checkPeriod(input);
      await assertOwnTimeReadable(client);
      return api.listTimeRegistrations(client, input);
    },
  }),
  defineTool({
    name: 'timelog_get_time_registration',
    title: 'Get Time Registration (TimeLog)',
    description:
      "Fetch one time registration by its TimeRegistrationID. Absence is shown as absence, without its reason. Acting as a person, only the person's own registration.",
    inputShape: { timeRegistrationId: idSchema.describe('TimeRegistrationID.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched time registration.',
    upstream: [FIND_PERSON, { access: 'read', method: 'GET', path: '/api/v1/time-tracking-item/{timeRegistrationId}' }],
    handler: async (client, input) => {
      const person = await personUserId(client);
      const found = (await api.getTimeRegistration(client, input)) as { registration: Record<string, unknown> | null };
      // Acting as a person: their own registration only, never another user's.
      if (person !== undefined && found.registration?.UserID !== person) throw new Error(NOT_OWN_REGISTRATION);
      return found;
    },
  }),
  defineTool({
    name: 'timelog_time_summary',
    title: 'Time Summary (TimeLog)',
    description:
      "Report of the token's user's hours in a period: total, billable, absence as one sum, and hours by project, by task and by day. Acting as a person, only when the person is the token's user (TimeLog reads time only for the token's user).",
    inputShape: periodShape(),
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Summarised time.',
    upstream: [FIND_PERSON, KEY_USER, { access: 'read', method: 'GET', path: '/api/v1/time-tracking-item/get-by-date' }],
    handler: async (client, input) => {
      checkPeriod(input);
      await assertOwnTimeReadable(client);
      return api.timeSummary(client, input);
    },
  }),
  defineTool({
    name: 'timelog_timesheet_status',
    title: 'Timesheet Status (TimeLog)',
    description:
      "Weekly timesheet status per employee in a period (for example submitted or approved), with department and manager. Optionally for one employee or department. Shows what the token's user may see.",
    inputShape: {
      ...periodShape(),
      employeeId: idSchema.optional().describe('Only this employee (UserID).'),
      departmentId: idSchema.optional().describe('Only this department.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed timesheet status.',
    upstream: [{ access: 'read', method: 'GET', path: '/api/v1/timesheet-status/weekly' }],
    handler: async (client, input) => {
      checkPeriod(input);
      return api.timesheetStatus(client, input);
    },
  }),
  defineTool({
    name: 'timelog_register_time',
    title: 'Register Time (TimeLog)',
    description:
      "Register hours on a task on a day. Without employeeId the time is the token's user's own; with employeeId it is registered for that employee, if the token's user may do so in TimeLog. Acting as a person, the time is the person's and employeeId must be left out (or be the person). Find the task with timelog_list_tasks first.",
    inputShape: {
      taskId: idSchema.describe('TaskID.'),
      date: dateSchema.describe('The day, YYYY-MM-DD.'),
      hours: hoursSchema.describe('Hours, more than 0 and at most 24, for example 1.5.'),
      comment: z.string().trim().max(2000).optional().describe('Comment.'),
      billable: z.boolean().optional().describe("Billable. Default: the task's setting."),
      employeeId: idSchema.optional().describe("Register for this employee (UserID) instead of the token's user."),
    },
    annotations: APPEND_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Registered time.',
    upstream: [FIND_PERSON, { access: 'write', method: 'POST', path: '/api/v1/time-registration' }],
    handler: async (client, input) => {
      const person = await personUserId(client);
      if (person === undefined) return api.registerTime(client, input);
      // Acting as a person: the time is theirs (UserID), never another employee's.
      if (input.employeeId !== undefined && input.employeeId !== person) throw new Error(OTHER_EMPLOYEE);
      return api.registerTime(client, { ...input, employeeId: person });
    },
  }),
  defineTool({
    name: 'timelog_update_time',
    title: 'Correct Time Registration (TimeLog)',
    description:
      "Correct one of the token's user's time registrations (acting as a person: one of the person's own): hours, day, task, comment or billable. Fields not given stay as they are. Absence cannot be changed here.",
    inputShape: {
      timeRegistrationId: idSchema.describe('TimeRegistrationID.'),
      hours: hoursSchema.optional().describe('New hours.'),
      date: dateSchema.optional().describe('New day, YYYY-MM-DD.'),
      taskId: idSchema.optional().describe('Move to this task (TaskID).'),
      comment: z.string().trim().max(2000).optional().describe('New comment.'),
      billable: z.boolean().optional().describe('Billable or not.'),
    },
    annotations: UPDATE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Corrected time registration.',
    upstream: [
      FIND_PERSON,
      { access: 'read', method: 'GET', path: '/api/v1/time-tracking-item/{timeRegistrationId}' },
      { access: 'write', method: 'POST', path: '/api/v1/time-registration/update-time' },
    ],
    handler: async (client, input) => {
      if (
        input.hours === undefined &&
        input.date === undefined &&
        input.taskId === undefined &&
        input.comment === undefined &&
        input.billable === undefined
      ) {
        throw new Error('Give at least one field to change.');
      }
      const person = await personUserId(client);
      return api.updateTime(client, person === undefined ? input : { ...input, ownerId: person });
    },
  }),
  defineTool({
    name: 'timelog_create_task',
    title: 'Create Task (TimeLog)',
    description:
      "Create a task on a project, or a sub-task under parentTaskId. Optional number, description, dates, budgeted hours, billable and task type. No prices. Acting as a person, only when the person is the token's user (TimeLog records the token's user as creator).",
    inputShape: {
      projectId: idSchema.describe('ProjectID.'),
      name: z.string().trim().min(1).max(200).describe('Task name.'),
      taskNo: z.string().trim().min(1).max(50).optional().describe('Task number.'),
      description: z.string().trim().max(4000).optional().describe('Description.'),
      startDate: dateSchema.optional().describe('Start day, YYYY-MM-DD.'),
      endDate: dateSchema.optional().describe('End day, YYYY-MM-DD.'),
      budgetHours: z.number().min(0).max(1_000_000).optional().describe('Budgeted hours.'),
      parentTaskId: idSchema.optional().describe('Create as a sub-task of this task (TaskID).'),
      isBillable: z.boolean().optional().describe('Billable.'),
      taskTypeId: idSchema.optional().describe('Task type.'),
    },
    annotations: APPEND_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created task.',
    upstream: [
      FIND_PERSON,
      KEY_USER,
      { access: 'write', method: 'POST', path: '/api/v1/task' },
      { access: 'write', method: 'POST', path: '/api/v1/task/create-sub-task' },
    ],
    // TimeLog has no user field on a task and records the token's user as its creator: acting as a person, it runs only
    // when the person is the token's user (CREATED_BY_KEY_USER_ONLY otherwise), never as the token's user for someone else.
    handler: async (client, input) => {
      await assertCreatorIsPerson(client);
      return api.createTask(client, input);
    },
  }),
  defineTool({
    name: 'timelog_create_project',
    title: 'Create Project (TimeLog)',
    description:
      "Create a project for a customer from a project template (timelog_list_project_templates). Optional number, description, project manager and dates. Acting as a person, only when the person is the token's user (TimeLog records the token's user as creator).",
    inputShape: {
      templateId: idSchema.describe('ProjectTemplateID.'),
      name: z.string().trim().min(1).max(200).describe('Project name.'),
      customerId: idSchema.describe('CustomerID.'),
      projectNo: z.string().trim().min(1).max(50).optional().describe('Project number.'),
      description: z.string().trim().max(4000).optional().describe('Description.'),
      projectManagerId: idSchema.optional().describe('Project manager (UserID).'),
      startDate: dateSchema.optional().describe('Start day, YYYY-MM-DD.'),
      endDate: dateSchema.optional().describe('End day, YYYY-MM-DD.'),
    },
    annotations: APPEND_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created project.',
    upstream: [FIND_PERSON, KEY_USER, { access: 'write', method: 'POST', path: '/api/v1/project/create-from-template' }],
    // As create_task: no user field, so acting as a person it runs only when the person is the token's user.
    handler: async (client, input) => {
      await assertCreatorIsPerson(client);
      return api.createProject(client, input);
    },
  }),
];

export function findTool(name: string): ToolDefinition | undefined {
  return TIMELOG_TOOLS.find(tool => tool.name === name);
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(TIMELOG_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (TIMELOG_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return TIMELOG_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          return mcpToolResult(tool, await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input)));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }],
          };
        }
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
  /**
   * The person to act as (gateway only, src/act-as.ts): a change is made for their own TimeLog user, found by the
   * email, or not at all. Never written to the audit.
   */
  actAs?: ActAs;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Normalise a host-supplied context; malformed values are ignored. */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  return {
    requestId: contextString(value.requestId, 200) ?? newRequestId(),
    caller: contextString(value.caller, 320),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  if (!inputPolicy.allowed) {
    await writeAuditEvent(
      { requestId, tool: tool.name, caller, action: 'policy_denied', target, reason: inputPolicy.reason },
      { redactor },
    );
    throw new Error(inputPolicy.reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

const MAX_REJECTED_FIELDS = 20;
const MAX_REJECTED_FIELD_LENGTH = 64;

/** Audit a call rejected before execution (unknown tool or invalid input); field names only. */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  reason: string,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const fields =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.keys(input)
          .sort()
          .slice(0, MAX_REJECTED_FIELDS)
          .map(key => redactInScope(key).slice(0, MAX_REJECTED_FIELD_LENGTH))
      : [];
  await writeAuditEvent({
    requestId,
    tool: redactInScope(toolName).slice(0, 100),
    caller,
    action: 'rejected',
    target: { fields },
    reason: redactInScope(reason).slice(0, 200),
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
