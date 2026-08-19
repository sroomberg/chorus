---
description: Join a shared chorus session. Usage: /chorus-join token="<token>" host="<host>" name="<display-name>" [email="<work-email>"]
---

Parse "$ARGUMENTS" as named fields `token`, `host`, `name`, and optional `email`.
Also accept positional form: first word = token, second word = host, remaining words = display name.

`name` is required. If it is missing, empty, or still the placeholder YOUR_NAME, ask for a real display name — do not invent one.
If `email` is omitted, empty, wrapped in square brackets, or the placeholder `<work-email>`, omit email unless the host requires a company domain.
Use the chorus-join tool with those values.
If the tool returns pending=true, tell the user to wait for the host to approve.
