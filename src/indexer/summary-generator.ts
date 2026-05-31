/** Code Memory Graph — Summary Generator */

import type { LlmConfig, SymbolRecord } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("summary-gen");

export class SummaryGenerator {
  private config: LlmConfig | null;

  constructor(config: LlmConfig | null) {
    this.config = config;
  }

  async summarizeCode(code: string, context: string): Promise<string | null> {
    if (!this.config) return null;
    if (!code || code.trim().length === 0) return null;

    const prompt = [
      "You are a code summarizer. Given a code snippet and its context,",
      "write a concise one-sentence summary of what the code does.",
      "Do not explain how it works, just what it does.",
      "Context: " + context,
      "Code:",
      "```",
      code.slice(0, 4000),
      "```",
      "Summary:",
    ].join("\n");

    return this.chatCompletion(prompt);
  }

  async summarizeFile(filePath: string, symbols: SymbolRecord[]): Promise<string | null> {
    if (!this.config) return null;
    if (symbols.length === 0) return null;

    const symbolList = symbols.map(function(s) {
      return "  - " + s.kind + " " + s.name + (s.signature ? ": " + s.signature.slice(0, 200) : "");
    }).join("\n");

    const prompt = [
      "You are a code file summarizer. Given a file path and its top-level symbols,",
      "write a one-paragraph summary of the file role and contents.",
      "Focus on what the file provides to the rest of the project.",
      "File: " + filePath,
      "Symbols:",
      symbolList,
      "Summary:",
    ].join("\n");

    return this.chatCompletion(prompt);
  }

  isAvailable(): boolean {
    return this.config !== null;
  }

  private async chatCompletion(prompt: string): Promise<string | null> {
    if (!this.config) return null;

    const provider = this.config.provider || "ollama";
    let baseUrl = this.config.baseUrl;
    let url: string;

    if (provider === "ollama") {
      baseUrl = baseUrl || "http://localhost:11434";
      url = baseUrl.replace(/\/$/, "") + "/api/chat";
    } else {
      baseUrl = baseUrl || "https://api.openai.com";
      url = baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = "Bearer " + this.config.apiKey;
    }

    let body: string;
    if (provider === "ollama") {
      body = JSON.stringify({
        model: this.config.model || "llama3.2",
        messages: [{ role: "user", content: prompt }],
        stream: false,
      });
    } else {
      body = JSON.stringify({
        model: this.config.model || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
        temperature: 0.3,
      });
    }

    try {
      const resp = await fetch(url, { method: "POST", headers, body });
      if (!resp.ok) {
        const errText = await resp.text().catch(function() { return ""; });
        log.error("LLM API error " + resp.status + ": " + errText.slice(0, 200));
        return null;
      }
      const data = await resp.json() as Record<string, unknown>;
      return extractContent(data, provider);
    } catch (err) {
      log.error("LLM API call failed", err);
      return null;
    }
  }
}

function extractContent(data: Record<string, unknown>, provider: string): string | null {
  try {
    if (provider === "ollama") {
      const msg = (data as { message?: { content?: string } }).message;
      return msg?.content?.trim() ?? null;
    }
    const choices = (data as { choices?: Array<{ message?: { content?: string } }> }).choices;
    if (choices && choices.length > 0 && choices[0].message?.content) {
      return choices[0].message.content.trim();
    }
    return null;
  } catch {
    return null;
  }
}