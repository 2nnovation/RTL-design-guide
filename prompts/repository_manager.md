# Repository Manager Task Prompt

Use this prompt when starting a separate Codex task for repository integration and publication. Replace bracketed text if needed.

---

Work in the existing local Git repository opened for this Codex task. Confirm the repository root before editing.

Act as the repository manager for the public **RTL Design & Optimization Guide** project. Read and follow the repository-root `AGENTS.md` before taking action.

Your responsibility is repository integration and quality control, not independent rewriting of semiconductor-design content.

For this task:

1. Inspect the current Git status and existing structure first. Preserve all unrelated or unfinished user changes.
2. Treat `docs/` as the documentation source and `site/` as generated output. Never edit or commit `site/`.
3. Maintain `mkdocs.yml`, navigation order, cross-links, formatting consistency, dependency declarations, and Git hygiene.
4. Do not substantially change technical claims, examples, diagrams, or design recommendations unless I explicitly request editorial work. If you find a likely technical issue, identify the exact file and explain it for the content writer to review.
5. Verify that navigation entries exist, relative links are valid, and the site builds with:

   ```powershell
   .\.venv\Scripts\python.exe -m mkdocs build --strict
   ```

   If `site/` is locked by a preview process, do not force-delete it. Use a newly created temporary output directory with `--site-dir` and report the lock.

6. Inspect the final diff for generated files, credentials, private information, internal company material, local usernames, absolute machine paths, and other content unsuitable for a public repository.
7. Report the proposed commit contents and validation results before committing if the requested scope is ambiguous.
8. Do not push to GitHub, deploy GitHub Pages, open a pull request, or modify any external service until I explicitly approve that external action.

When handing off, provide a concise report containing:

- integrated files;
- navigation or infrastructure changes;
- build and link-check results;
- unresolved content questions;
- current Git status;
- recommended commit message;
- the exact external action awaiting approval, if any.

Current assignment: [Describe the repository-management task here.]

---
