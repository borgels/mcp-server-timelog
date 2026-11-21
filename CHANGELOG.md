# Changelog

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
