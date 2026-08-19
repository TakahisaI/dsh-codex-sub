# Alpha real-account smoke record template

Copy this template into a maintainer-controlled note while running the exact release-candidate
tarball. Post only the completed, secret-free record to the release issue. Do not attach terminal
output, screenshots, model responses, browser history, or the temporary DSH home.

## Candidate identity

| Field | Value |
| --- | --- |
| Package version | `REPLACE` |
| Tarball SHA-256 | `REPLACE` |
| Git commit | `REPLACE` |
| Operating system family/version | `REPLACE` |
| Node version | `REPLACE` |
| DSH release | `REPLACE` |
| pi-ai version | `REPLACE` |
| Public catalog model ID, if recorded | `OMITTED` |

Do not record an account email, account or workspace ID, plan name, token timestamp, authorization
URL or code, credential path, model response, usage, or quota.

## Smoke results

Use only `PASS`, `FAIL (issue reference)`, or `DEFERRED (reason)`.

| Step | Result |
| --- | --- |
| Fresh temporary DSH home and profile | `REPLACE` |
| Exact tarball installed | `REPLACE` |
| Signed-out status is secret-free | `REPLACE` |
| Offline doctor matches the verified combination | `REPLACE` |
| Interactive ChatGPT/Codex OAuth login | `REPLACE` |
| Signed-in status contains no account metadata | `REPLACE` |
| Ordinary selector shows the provider catalog | `REPLACE` |
| Plain text request | `REPLACE` |
| Harmless DSH-owned tool flow with approval | `REPLACE` |
| In-flight cancellation and recovery | `REPLACE` |
| DSH restart and session resume | `REPLACE` |
| Refresh path or safely deferred natural expiry | `REPLACE` |
| Post-request doctor remains offline and secret-free | `REPLACE` |
| Logout | `REPLACE` |
| Next request fails with `CODEX_AUTH_REQUIRED` | `REPLACE` |
| Uninstall changes no unrelated state | `REPLACE` |

## Final safety review

- [ ] The record contains no credential, authorization, account, path, environment-dump, or
      conversation data.
- [ ] No real credential exists under the repository workspace or in a CI environment.
- [ ] The tested tarball checksum matches the candidate intended for publication.
- [ ] Every failure points only to a sanitized issue.
- [ ] The temporary DSH home was deleted after the test.
