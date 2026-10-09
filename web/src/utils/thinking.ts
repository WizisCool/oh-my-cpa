/** Extract thinking blocks if model outputs inline <think> tags. */
export function extractThinking(text: string): { thought?: string; reply: string; isThinking?: boolean } {
  const openTag = '<think>';
  const closeTag = '</think>';
  const openIndex = text.indexOf(openTag);
  if (openIndex === -1) return { reply: text, isThinking: false };
  const closeIndex = text.indexOf(closeTag, openIndex);
  if (closeIndex === -1) {
    return {
      thought: text.slice(openIndex + openTag.length).trim(),
      reply: text.slice(0, openIndex).trim(),
      isThinking: true,
    };
  }
  const thought = text.slice(openIndex + openTag.length, closeIndex).trim();
  const reply = (text.slice(0, openIndex) + text.slice(closeIndex + closeTag.length)).trim();
  return { thought: thought || undefined, reply, isThinking: false };
}
