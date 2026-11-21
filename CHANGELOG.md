# Changelog

## 0.1.0

- First release: tools for the TimeLog REST API (v1) with a personal access
  token, built from the MCP server template. Reads of projects, project
  templates, tasks, customers, employees, the token user's time
  registrations, a time summary and weekly timesheet status; writes that
  register and correct time and create tasks and projects, and change a
  project's name, description, project manager or budgeted hours.
- Results are reduced to a list of fields per object: no amounts, hourly
  rates, cost prices or salaries, and absence without its code, name or
  comment. Nothing deletes.
- Gateway (`./gateway`) in the template's shape: explicit credentials (token
  and account address), key admission, instance policy from the host, call
  scopes, the sink check and a frozen tool catalog with the upstream requests
  of each tool.
