---
description: Approve a pending chorus joiner. Usage: /chorus-approve [id]
---

Use the chorus-approve tool. If "$ARGUMENTS" is non-empty after trimming, pass it as userId — it may be a queue number (1, 2, …) or a full userId. If "$ARGUMENTS" is empty, omit userId so the tool can approve the only pending joiner.
When the tool returns pendingQueueText, show that numbered list to the host.
