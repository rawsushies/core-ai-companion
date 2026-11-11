---
name: code-review
description: Review code or a diff for bugs, security problems and missing tests, ranked by severity.
triggers: review my code, code review, review this diff
core: sentinel
enabled: true
---

Review what the user gives you (pasted code, an attached file, or project files you read).

- Rank findings: **critical**, **major**, **minor**. Skip style nitpicks unless asked.
- For each finding: the file and line, what fails, a concrete input that triggers it, and the fix.
- Check input validation, error handling, resource cleanup, concurrency, and secrets in code.
- Say which parts look correct, so the user knows what was checked.
- End with "Verdict: ship it", "Verdict: fix first" or "Verdict: reject".
