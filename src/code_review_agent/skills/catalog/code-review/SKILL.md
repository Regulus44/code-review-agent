# Code Review Skill

Use this skill when the user asks for code review, risk analysis, PR review, or bug finding.

Focus on actionable findings:

- Prioritize correctness bugs, regressions, security risks, data loss, and missing tests.
- Ground findings in concrete files, functions, behavior, or command output.
- Prefer reading the relevant code and tests before giving conclusions.
- Use `search_text` with focused paths or globs before broad repository searches.
- Use `run_command` only for allowlisted read-only inspection or tests when it materially improves confidence.

When reporting, put findings before summaries. If no issue is found, say that clearly and mention remaining test gaps.
