import type {
  CodexAuthStatus,
  DoctorReportV1,
  StatusReportV1,
} from '../core/contracts.js'
import type { CliIo } from './types.js'

export const CLI_HELP = `Usage: dsh-codex-sub <command> [options]

Commands:
  login            Sign in with ChatGPT/Codex OAuth
  logout           Remove this package's stored credential
  status [--json]  Show local sign-in status without network access
  doctor [--json]  Show offline compatibility diagnostics
  version          Print the package version

Options:
  -h, --help       Show this help
`

export function writeJson(io: CliIo, value: StatusReportV1 | DoctorReportV1): void {
  io.stdout(`${JSON.stringify(value)}\n`)
}

export function writeStatus(io: CliIo, status: CodexAuthStatus): void {
  switch (status.state) {
    case 'signed-out':
      io.stdout('Signed out.\n')
      break
    case 'signed-in':
      io.stdout(status.refreshExpected
        ? 'Signed in. Authentication will refresh on the next model request.\n'
        : 'Signed in. The local access token is fresh.\n')
      break
    case 'invalid-storage':
      io.stdout('Credential storage is invalid. Run doctor for safe details.\n')
      break
    case 'insecure-storage':
      io.stdout('Credential storage is insecure. Run doctor for safe details.\n')
      break
  }
}

function installedVersion(value: string | null): string {
  return value ?? 'unknown'
}

export function writeDoctor(io: CliIo, report: DoctorReportV1): void {
  io.stdout(`Overall: ${report.overall}\n`)
  io.stdout(`Package: ${report.package.name} ${report.package.version}\n`)
  io.stdout(`Node: ${installedVersion(report.runtime.node.installed)} (${report.runtime.node.status})\n`)
  io.stdout(`DSH LLM: ${installedVersion(report.runtime.dshLlm.installed)} (${report.runtime.dshLlm.status})\n`)
  io.stdout(`DSH pi-ai: ${installedVersion(report.runtime.dshPiAi.installed)} (${report.runtime.dshPiAi.status})\n`)
  io.stdout(`pi-ai: ${installedVersion(report.runtime.piAi.installed)} (${report.runtime.piAi.status})\n`)
  io.stdout(`Credential store: ${report.credentialStore.state} (${report.credentialStore.permissions})\n`)
  io.stdout(`Codex catalog models: ${String(report.catalog.modelCount)}\n`)
  for (const hint of report.hints) {
    io.stdout(`Hint: ${hint}\n`)
  }
}
