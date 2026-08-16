---
description: Share the current session. Usage: /chorus-share [edit|view|admin] [requireApproval=true|false]
---

Parse "$ARGUMENTS" for an optional role (edit, view, or admin; default edit) and optional requireApproval=true or requireApproval=false (default true).
Use the chorus-share tool with those values.
Show the returned `connect` field clearly — it is a ready-to-run `/chorus-join` command for the collaborator.
Remind the host that joiners need a display name, and that pending joiners need chorus-approve (unless requireApproval was false).
