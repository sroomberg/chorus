---
description: Join a shared chorus session. Usage: /chorus-join <token> <host> <name>
---

Parse the arguments "$ARGUMENTS" as: first word = token, second word = host (e.g. 192.168.1.5:7742), remaining words = display name (required).
If the display name is missing, ask for one before calling the tool — do not invent a placeholder.
Use the chorus-join tool with those values.
If the tool returns pending=true, tell the user to wait for the host to approve.
