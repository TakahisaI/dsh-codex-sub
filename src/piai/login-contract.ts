import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
} from '@earendil-works/pi-ai'

// Keep the CLI free of direct pi-ai imports while making upstream interaction
// union changes visible to TypeScript at this isolated boundary.
export type PiAiLoginEvent = AuthEvent
export type PiAiLoginInteraction = AuthInteraction
export type PiAiLoginPrompt = AuthPrompt
