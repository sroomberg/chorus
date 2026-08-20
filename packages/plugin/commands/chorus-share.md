---
description: Share the current session. Usage: /chorus-share [edit|view|admin] [requireApproval=true|false]
---

Parse "$ARGUMENTS" for an optional role (edit, view, or admin; default edit) and optional requireApproval=true or requireApproval=false (default false).
Use the chorus-share tool with those values.
Show the returned `connect` field clearly — it is a `/chorus-join` command for the collaborator.
Keep placeholders such as name="YOUR_NAME" and optional `[email="<work-email>"]` so they can fill them in before running it.
Remind the host that joiners need a display name. If requireApproval is true, pending joiners appear as a numbered queue on screen — approve with /chorus-approve 1 (or A), not the full userId.
