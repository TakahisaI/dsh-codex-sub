# Known limitations

## Verified compatibility

The unpublished `0.1.0-alpha.2` candidate records only the combination below. It has not been
published or verified as public support; a newer version is unsupported until its public contracts
and packed installation have been reviewed.

| Component | Verified value |
| --- | --- |
| DeepSeek Harness | `0.1.1-rc.1` |
| `@deepseek-ai/cordis` | `4.0.1` |
| `@earendil-works/pi-ai` | `0.82.1` |
| Node.js | `^22.19.0 || ^24.0.0 || ^26.0.0` |
| Operating systems | Linux and macOS |

Windows is unsupported because the current vault cannot verify owner-only credential ACLs there.
Odd Node majors, prerelease Node builds, and untested future majors fail the compatibility guard.

## Authentication and account eligibility

The package uses a separate ChatGPT/Codex OAuth login. It does not read Codex CLI, ChatGPT Desktop,
another plugin's credentials, or an OpenAI Platform API key.

Credentials are stored as plaintext in `$DSH_HOME/dsh-codex-sub/auth.json`. On supported POSIX
systems, filesystem permissions restrict the directory and file to the current user. The package
does not claim encryption or protection from an administrator, another process running as the same
user, a compromised dependency, terminal capture, or memory inspection.

Model visibility does not guarantee account access. Eligibility, model availability, quota,
backend behavior, and OAuth behavior are controlled upstream and can change independently of this
package.

## Product boundary

The Alpha has no Web account UI, multiple-account support, usage or quota display, search provider,
image-fetching tool, Fast Mode, configurable endpoint or headers, MCP, Codex App Server, or alternate
agent loop. DSH continues to own tools, approvals, sessions, attachments, compaction, persistence,
and recovery.

Uninstalling the package preserves its credential file. Run `logout` before uninstall when the
credential should be removed. Logout removes only `auth.json` and does not remove unrelated files.

## Support boundary

`status` and `doctor` describe local state only. They do not validate the upstream account or make a
network request. Support requests should include exact versions and sanitized `doctor --json`
output only. Never post credentials, authorization data, account identifiers, full environment
dumps, local paths, or model conversations.

This project is independently maintained and is not affiliated with or endorsed by OpenAI,
ChatGPT, Codex, DeepSeek, DeepSeek Harness, or earendil-works.
