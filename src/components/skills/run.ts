import { aiChatLink, aiPrefilledChatLink, openAiConnector, type AiClient } from '@/lib/onboarding/ai-clients'

/**
 * Opens a chat for the prompt. The chat opens synchronously so the popup is
 * not blocked. With `prefill` the prompt is typed into the new chat through
 * ?q= (see aiPrefilledChatLink): only for curated agents, whose prompt is
 * fixed text plus an agent id. An own agent's prompt carries the name the
 * user wrote, so it is copied for them to paste into an empty chat instead.
 */
export function copyPromptAndOpen(prompt: string, client: AiClient, prefill = false): Promise<boolean> {
  if (prefill) {
    openAiConnector(aiPrefilledChatLink(client, prompt))
    return Promise.resolve(true)
  }
  const copying = navigator.clipboard?.writeText(prompt) ?? Promise.reject(new Error('No clipboard'))
  openAiConnector(aiChatLink(client))
  return copying.then(() => true, () => false)
}
