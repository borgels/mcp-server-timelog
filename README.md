# mcp-server-timelog

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [TimeLog](https://www.timelog.com) REST API. It lets an MCP client (Claude or any other MCP-capable assistant) read projects, tasks, customers, employees and time registrations in TimeLog and, when enabled, register and correct time and create tasks and projects.

> This is an independent, unofficial project. It is not developed, endorsed or supported by TimeLog A/S.

It authenticates with a **personal access token (PAT)**, which has the rights of the TimeLog user who made it ([TimeLog: personal access tokens](https://api.timelog.com/rest/personalaccesstokens)). Everything the server can see or change is limited by that user's rights in TimeLog. Results are reduced to a list of fields per object: no amounts, hourly rates, cost prices or salaries are returned, and an absence registration is returned without its absence code, name or comment. Nothing deletes, and users and settings are not touched. TimeLog's Reporting API needs a separate service user and is not used.

- Read-only by default; writes are opt-in per instance.
- One set of upstream credentials per server instance; the server does no per-user authorization itself (see [Security model](#security-model)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

## Tools

| Tool | Purpose |
|---|---|
| `timelog_check_connection` | Check the token and show which TimeLog user it belongs to. |
| `timelog_list_projects` | List active (or inactive) projects, or search them by name or number. No amounts. |
| `timelog_get_project` | One project, optionally with its tasks. |
| `timelog_list_project_templates` | Project templates a new project can be created from. |
| `timelog_list_tasks` | A project's tasks, or tasks time can be registered on, by name or number. |
| `timelog_get_task` | One task with its project. |
| `timelog_list_customers` | List or search customers. |
| `timelog_get_customer` | One customer. |
| `timelog_list_employees` | Employees (users) with name, initials, type and work email. |
| `timelog_get_employee` | One employee. |
| `timelog_list_time_registrations` | The token user's time registrations in a period (at most a year). |
| `timelog_get_time_registration` | One time registration. |
| `timelog_time_summary` | The token user's hours in a period: total, billable, absence, by project, task and day. |
| `timelog_timesheet_status` | Weekly timesheet status per employee (what the token user may see). |
| `timelog_register_time` *(write)* | Register hours on a task, for the token user or, if TimeLog allows it, another employee (through the gateway: for the person in `actAs`). |
| `timelog_update_time` *(write)* | Correct a registration: hours, day, task, comment or billable. Other fields are kept. |
| `timelog_create_task` *(write)* | Create a task or a sub-task on a project. |
| `timelog_create_project` *(write)* | Create a project for a customer from a template. |

`update_time` reads the registration first and sends back every field it does not change, because TimeLog's update replaces them. Projects can be created but not changed: TimeLog's project update replaces every field, and its read model does not include all of them (the invoice language), so a change could reset one. Period reads (`list_time_registrations`, `time_summary`) read every page before they sum; a result says `incomplete: true` if TimeLog reports more than 40 pages of 500.

## Quick start

Requires Node.js 22 or later, your TimeLog address (`https://app<n>.timelog.com/<account>`, as in the browser after signing in) and a personal access token from <https://login.timelog.com/personaltoken>.

```bash
npx mcp-server-timelog
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-timelog.git
cd mcp-server-timelog
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add timelog \
  --env TIMELOG_API_KEY=<token> --env TIMELOG_BASE_URL=https://app1.timelog.com/youraccount \
  -- npx -y mcp-server-timelog
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "timelog": {
      "command": "npx",
      "args": ["-y", "mcp-server-timelog"],
      "env": {
        "TIMELOG_API_KEY": "<token>",
        "TIMELOG_BASE_URL": "https://app1.timelog.com/youraccount"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-timelog`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name timelog-mcp -p 127.0.0.1:3000:3000 \
  -e TIMELOG_API_KEY=<token> \
  -e TIMELOG_BASE_URL=https://app1.timelog.com/youraccount \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-timelog:latest

claude mcp add --transport http timelog http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `TIMELOG_AUDIT_LOG` into it (e.g. `-v timelog-audit:/audit -e TIMELOG_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Upstream API

| Variable | Default | Description |
|---|---|---|
| `TIMELOG_API_KEY` | – | **Required.** Personal access token, sent as `Authorization: Bearer <token>`. |
| `TIMELOG_BASE_URL` | – | **Required.** The account address, `https://app<n>.timelog.com/<account>`; the server calls `<address>/api/v1/...`. Must be `https` on `timelog.com` (loopback `http` is allowed for local mocks). |
| `TIMELOG_ALLOW_CUSTOM_BASE_URL` | `false` | Allow a base URL outside the hosts the server expects, when such a list is configured. |
| `TIMELOG_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `TIMELOG_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `TIMELOG_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `TIMELOG_ENABLE_WRITES` | `false` | Enable the write tools. |
| `TIMELOG_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `timelog_` prefix. |
| `TIMELOG_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids in clear text, free text hashed, duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createTimelogGateway, timelogToolCatalog } from 'mcp-server-timelog/gateway';

const gateway = createTimelogGateway({ apiKey: tenant.apiKey, baseUrl: tenant.baseUrl });
const result = await gateway.callTool('list_projects', { query: 'website' }, { caller: 'person-1' });
```

- **Explicit credentials.** `apiKey` and `baseUrl` are required; a missing value throws when the gateway is created. A gateway never reads `TIMELOG_API_KEY` or `TIMELOG_BASE_URL` from the environment, so one tenant cannot silently fall back to the process's credentials. The stdio and HTTP transports still read them from the environment.
- **Several tenants in one process.** Create one gateway per set of credentials. Each instance redacts error text, tool results and audit records with its own key only; no secret is kept in a process-wide registry, and a dropped instance releases its key.
- **Instance policy from the host.** Pass `policy` to `createTimelogGateway`: `enableWrites` (default false), `disabledTools` (must name known tools) and `audit`, a function that receives each audit record instead of `TIMELOG_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `TIMELOG_ENABLE_WRITES`, `TIMELOG_DISABLED_TOOLS`, `TIMELOG_AUDIT_LOG` or `TIMELOG_ALLOW_CUSTOM_BASE_URL`, so tenants in one process can have different settings. Without `policy` the instance uses the environment, like the MCP server. Each call runs in a scope of its own, so a call made from inside another instance's call never inherits its policy, sink or redactor, and every audit record is redacted as a whole with the instance's own key before the sink sees it. The limits (`TIMELOG_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user and per-tenant authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON, as the MCP specification recommends (many clients read only the text). The JSON is built from the redacted result, so it holds exactly `structuredContent`. An error result has only its text, and, when the upstream API answered with an HTTP error, `failure: { httpStatus, requestId? }`: the status, and the vendor's request id from a response header (`REQUEST_ID_HEADERS` in `src/errors.ts`) only when it is a hex id of 8 to 64 characters (one run of hex digits, or groups of four or more joined by single hyphens, as in a UUID) and does not hold the shape of a personal number. A host can count failures from it without reading their text. Never the response body, the vendor's error code or message.
- **Acting as a person (`actAs`).** A host that verified the person a call is made for passes `actAs: { email }` in the call context (`gateway.callTool(name, input, { caller, actAs })`, `src/act-as.ts`, the template's shared shape). Every **change** (the write tools) then first finds exactly one active TimeLog user whose `Email` is that address (every page of `GET /api/v1/user` as the token's user, compared case-insensitively) and is made for that user:
  - `register_time` sends the person's `UserID`, so the time is theirs. An `employeeId` for another employee is refused with `OTHER_EMPLOYEE` before anything is sent. The token's user must be allowed to register time for others in TimeLog.
  - `update_time` changes only a registration whose `UserID` is the person's (`NOT_OWN_REGISTRATION` otherwise).
  - `create_task` and `create_project` have no user field in TimeLog: they run only when the person has a user, and TimeLog records the token's user as their creator.
  - No such user, an inactive one, more than one, or a user list longer than 20 pages of 500 (so a second user may be missing): nothing is sent, and the result is an error with `actAsRefused: 'no_user'`. TimeLog answering 403 to the user list (the token's user may not see users): `actAsRefused: 'not_permitted'`. A malformed `actAs` (`null` included): `actAsRefused: 'invalid'`, before anything is sent.
  - A change is never made as the token's own user instead.
  - **Reads.** TimeLog's REST reads of a period of time (`time-tracking-item/get-by-date`) have no user parameter: they return the token user's own time only. With `actAs`, `list_time_registrations` and `time_summary` therefore run only when the person is the token's user (`GET /api/v1/user/me`) and are refused with `OWN_TIME_ONLY` otherwise; `get_time_registration` returns only the person's own registration (`NOT_OWN_REGISTRATION`). Reading another user's time would need TimeLog's Reporting API with its own service user, which this server does not use. Every other read runs as the token's user.
  - The server sends the email nowhere (the user list is read whole and compared in the server) and adds it to no audit record, text or field of its own.

  Without `actAs` every call runs as the token's own user, as before. The refusal texts are exported (`OWN_TIME_ONLY`, `NOT_OWN_REGISTRATION`, `OTHER_EMPLOYEE`, `ACT_AS_TEXTS`).
- **Tool catalog.** `timelogToolCatalog` is a frozen list of every tool: `name` (without the `timelog_` prefix), `title`, `description`, `riskLevel` (`read`, `write` or `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (true when a tool can read more than its name says, so a host gives it only to roles that may read everything) and `upstream`, the API requests the tool may make (`access`, `method` and path template). It is generated from the same tool table as the MCP server, so it cannot drift from the registered tools. `timelogGatewayTools` holds the same definitions without `upstream` and `broad`; `gateway.tools` lists those enabled on the instance.

## Threat model

What this server guarantees about the API key, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one key, keeps best-effort
redaction: its errors and audit records are redacted with its key, but it is
not held to these guarantees.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own key before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A failure kept
  inside an otherwise returned result is the status or a fixed text as well.
  Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one key.

**Not guaranteed (residual risk):** a vendor that deliberately echoes the
customer's own key back in data. Results are redacted on a best-effort
basis: the exact key, its URL- and JSON-encoded forms and any piece of it of
6 characters or more, in strings, object keys and the string form of
numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. A key that comes back otherwise transformed (split into pieces
shorter than 6 characters, reversed, re-encoded, hashed) is not recognised.
Such data reaches only the tenant whose key it is, which already holds the
key. **What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), audit records and stderr lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** Every key is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key. The standalone MCP server applies the same redaction to errors
and audit records on a best-effort basis; its successful results are passed
on as the API returned them.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured API key. Give it the least rights that work and rotate it regularly.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the API key can see. To separate data, run several instances with different keys.
- **Writes are off by default.** Write tools are annotated as writes (`readOnlyHint: false`); none deletes, so none is marked destructive. Clients can still ask for confirmation before any write. Read-only tools get a client that refuses non-GET requests. When `TIMELOG_AUDIT_LOG` is set, a write tool does not run unless its start record is written; without it there is no audit record.
- **Upstream content is untrusted input.** Data returned by the API may be written by anyone with access to it. Tool results label it as data; clients that combine this server with other tools should treat it accordingly.
- **The API key stays on the API origin.** Redirects are never followed, the base URL must use `https`, and error messages and audit records are redacted (by each instance, with that instance's key) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

Project layout:

| Path | Contents |
|---|---|
| `src/tools/timelog.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/timelog/` | Upstream client, API calls, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml` (and [docs/NEW-SERVER.md](docs/NEW-SERVER.md)).

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.
- **Earlier versions:** versions released before 0.3.0 were licensed under Apache-2.0 and remain so.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them. See also [NOTICE](NOTICE).
