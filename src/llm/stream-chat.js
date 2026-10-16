/**
 * Incremental chat text from provider streams (OpenAI SSE or Ollama NDJSON).
 * Providers without chatStream fall back to one full reply.
 */

export async function* readTextChunks(body) {
  const reader = body?.getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(':')) continue;
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (!payload || payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const piece = json.choices?.[0]?.delta?.content
        ?? json.delta?.text
        ?? json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('')
        ?? json.message?.content
        ?? json.response
        ?? '';
      if (piece) yield String(piece);
    }
  }
}

export async function streamChat(provider, messages, options = {}, onDelta) {
  if (provider && typeof provider.chatStream === 'function') {
    let all = '';
    for await (const part of provider.chatStream(messages, options)) {
      if (!part) continue;
      all += part;
      onDelta?.(part);
    }
    return all.trim();
  }
  const text = String(await provider.chat(messages, options) || '').trim();
  if (text) onDelta?.(text);
  return text;
}
