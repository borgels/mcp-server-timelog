# Changelog

## 0.4.0

- Gateway: changes are made as the person the host names. A host passes
  `actAs: { email }` (the template's shared shape, `src/act-as.ts`) in the
  call context; every write tool then first finds exactly one active TimeLog
  user with that email (every page of `GET /api/v1/user`, as the token's user,
  compared case-insensitively) and is made for that user: `register_time`
  sends their `UserID` (an `employeeId` for someone else is refused,
  `OTHER_EMPLOYEE`), `update_time` changes only their own registration
  (`NOT_OWN_REGISTRATION`), and `create_task` and `create_project`, which have
  no user field in TimeLog, run only when the person has a user (TimeLog
  records the token's user as creator). No such user, more than one, or a
  user list longer than 20 pages of 500: nothing is sent,
  `actAsRefused: 'no_user'`. TimeLog refusing the user list (403):
  `actAsRefused: 'not_permitted'`. A malformed `actAs`: `invalid`. Never a
  fallback to the token's user for a change; the email is never audited or
  returned. The catalog's write tools declare the lookup first in `upstream`.
- Reads with `actAs`: TimeLog's period reads of time
  (`time-tracking-item/get-by-date`) have no user parameter and return only
  the token user's own time, so `list_time_registrations` and `time_summary`
  run only when the person is the token's user (`GET /api/v1/user/me`), and
  are refused with `OWN_TIME_ONLY` otherwise. `get_time_registration` returns
  only the person's own registration. Other reads run as the token's user.

## 0.3.1

- Licensor and copyright holder corrected to Borgels Services ApS in `LICENSE`,
  `NOTICE` and `CONTRIBUTING.md`. The license is unchanged (FSL-1.1-ALv2).

## 0.3.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.3.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.2.0

- Gateway error results carry failure metadata: when the upstream API
  answered with an HTTP error, the result has `failure: { httpStatus,
  requestId? }`, so a host can count failures by status without reading
  their text. `requestId` is the vendor's own id from a response header
  (`REQUEST_ID_HEADERS`: the common request-id headers), kept only
  when it is a hex id of 8 to 64 characters (one run of hex digits,
  or groups of four or more joined by single hyphens, as in a UUID) and does not hold the
  shape of a personal number. It is checked again after redaction, so an id
  that shared a piece with the key is dropped. Never the body, the vendor's
  error code or message. The shared helpers are in `src/errors.ts`
  (`vendorRequestId`, `requestIdFrom`, `failureMetadata`).

## 0.1.0

- First release: tools for the TimeLog REST API (v1) with a personal access
  token, built from the MCP server template. Reads of projects, project
  templates, tasks, customers, employees, the token user's time
  registrations, a time summary and weekly timesheet status; writes that
  register and correct time and create tasks and projects. Period reads
  read every page before they sum.
- Results are reduced to a list of fields per object: no amounts, hourly
  rates, cost prices or salaries, and absence without its code, name or
  comment. Nothing deletes.
- Gateway (`./gateway`) in the template's shape: explicit credentials (token
  and account address), key admission, instance policy from the host, call
  scopes, the sink check and a frozen tool catalog with the upstream requests
  of each tool.
