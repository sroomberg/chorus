---
description: Deny a pending chorus joiner. Usage: /chorus-deny [id]
---

Use the chorus-deny tool. If "$ARGUMENTS" is non-empty after trimming, pass it as userId — it may be a queue number (1, 2, …) or a full userId. If "$ARGUMENTS" is empty, omit userId so the tool can deny the only pending joiner.
When the tool returns pendingQueueText, show that numbered list to the host.
