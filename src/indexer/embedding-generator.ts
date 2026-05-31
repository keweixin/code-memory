/** Code Memory Graph — Embedding Generator */

import type { EmbeddingConfig } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("embedding-gen");

export class EmbeddingGenerator {
  private config: EmbeddingConfig;
  private available: boolean = false;

  constructor(config: EmbeddingConfig) {
    this.config = config;
    this.available = config.provider !== "none";
  }

  async generate(text: string): Promise<number[]> {
    if (!this.available) throw new Error("Embedding generator not available (provider is none)");
    if (!text || text.trim().length === 0) return [];
    const trimmed = text.trim();
    switch (this.config.provider) {
      case "ollama": return this.ollama(trimmed);
      case "openai": return this.openai(trimmed);
      default: throw new Error("Unknown provider: " + this.config.provider);
    }
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    if (!this.available) throw new Error("Not available");
    const results: number[][] = [];
    for (const text of texts) {
      try { results.push(await this.generate(text)); }
      catch (err) { log.error("Batch embedding failed", err); results.push([]); }
    }
    return results;
  }

  isAvailable(): boolean { return this.available; }

  getDimensions(): number | undefined { return this.config.dimensions; }

  private async ollama(text: string): Promise<number[]> {
    const baseUrl = this.config.baseUrl || "http://localhost:11434";
    const url = baseUrl.replace(/\/$/, "") + "/api/embeddings";
    const body = JSON.stringify({
      model: this.config.model || "nomic-embed-text",
      prompt: text,
    });
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error("Ollama API error " + resp.status + ": " + errText.slice(0, 200));
    }
    const data = await resp.json() as { embedding?: number[] };
    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error("Ollama response missing embedding");
    }
    return data.embedding;
  }

  private async openai(text: string): Promise<number[]> {
    const baseUrl = this.config.baseUrl || "https://api.openai.com";
    const url = baseUrl.replace(/\/$/, "") + "/v1/embeddings";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) headers["Authorization"] = "Bearer " + this.config.apiKey;
    const body = JSON.stringify({
      model: this.config.model || "text-embedding-3-small",
      input: text,
    });
    const resp = await fetch(url, { method: "POST", headers, body });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error("OpenAI API error " + resp.status + ": " + errText.slice(0, 200));
    }
    const data = await resp.json() as { data?: Array<{ embedding?: number[] }> };
    if (!data.data || data.data.length === 0 || !data.data[0].embedding) {
      throw new Error("OpenAI response missing embedding");
    }
    return data.data[0].embedding;
  }
}