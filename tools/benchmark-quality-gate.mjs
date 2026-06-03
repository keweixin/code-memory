#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const options = parseArgs(process.argv.slice(2));
const failures = [];
const thresholds = {
  indexMinThroughput: numberEnv('CODE_MEMORY_GATE_INDEX_MIN_THROUGHPUT', 5),
  indexMaxRssMb: numberEnv('CODE_MEMORY_GATE_INDEX_MAX_RSS_MB', 1200),
  contextMinKeyFileRecall: numberEnv('CODE_MEMORY_GATE_CONTEXT_MIN_KEY_FILE_RECALL', 0.90),
  contextMinEvidenceCoverage: numberEnv('CODE_MEMORY_GATE_CONTEXT_MIN_EVIDENCE_COVERAGE', 0.95),
  contextMinSymbolRecall: numberEnv('CODE_MEMORY_GATE_CONTEXT_MIN_SYMBOL_RECALL', 0.80),
  contextMaxTokenWasteRatio: numberEnv('CODE_MEMORY_GATE_CONTEXT_MAX_TOKEN_WASTE_RATIO', 0.50),
  agentMinKeyFileRecall: numberEnv('CODE_MEMORY_GATE_AGENT_MIN_KEY_FILE_RECALL', 0.90),
  agentMinEvidenceCoverage: numberEnv('CODE_MEMORY_GATE_AGENT_MIN_EVIDENCE_COVERAGE', 0.95),
  agentMaxHallucinatedSymbolRate: numberEnv('CODE_MEMORY_GATE_AGENT_MAX_HALLUCINATED_SYMBOL_RATE', 0.05),
  agentMaxStaleFailureRate: numberEnv('CODE_MEMORY_GATE_AGENT_MAX_STALE_FAILURE_RATE', 0),
};

if (options.index) {
  checkIndex(readJsonFile(options.index));
}
if (options.context) {
  checkContext(readJsonFile(options.context));
}
if (options.agent) {
  checkAgent(readJsonFile(options.agent));
}

if (failures.length > 0) {
  console.error('Benchmark quality gate failed:');
  for (const failure of failures) {
    console.error('- ' + failure);
  }
  process.exit(1);
}

console.log('Benchmark quality gate passed.');

function checkIndex(json) {
  if (Number(json.files || 0) <= 0) {
    failures.push('index benchmark produced zero indexed files');
  }
  if (isNumber(json.parseThroughputFilesPerSec) && json.parseThroughputFilesPerSec < thresholds.indexMinThroughput) {
    failures.push(
      `index throughput ${json.parseThroughputFilesPerSec} files/s is below ${thresholds.indexMinThroughput}`,
    );
  }
  if (isNumber(json.peakRssMb) && json.peakRssMb > thresholds.indexMaxRssMb) {
    failures.push(`index peak RSS ${json.peakRssMb}MB exceeds ${thresholds.indexMaxRssMb}MB`);
  }
}

function checkContext(json) {
  const metrics = json.primaryMetrics || json.metrics || {};
  assertMin(metrics.keyFileRecall, thresholds.contextMinKeyFileRecall, 'context keyFileRecall');
  assertMin(metrics.evidenceCoverage, thresholds.contextMinEvidenceCoverage, 'context evidenceCoverage');
  assertMin(metrics.symbolRecall, thresholds.contextMinSymbolRecall, 'context symbolRecall');
  assertMax(metrics.tokenWasteRatio, thresholds.contextMaxTokenWasteRatio, 'context tokenWasteRatio');
}

function checkAgent(json) {
  const metrics = json.metrics || {};
  if (json.status !== 'measured') {
    failures.push(`agent benchmark status is ${json.status ?? 'missing'}, expected measured`);
  }
  if (metrics.taskSuccess === false) {
    failures.push('agent benchmark taskSuccess is false');
  }
  assertMin(metrics.keyFileRecall, thresholds.agentMinKeyFileRecall, 'agent keyFileRecall');
  assertMin(metrics.evidenceCoverage, thresholds.agentMinEvidenceCoverage, 'agent evidenceCoverage');
  assertMax(metrics.hallucinatedSymbolRate, thresholds.agentMaxHallucinatedSymbolRate, 'agent hallucinatedSymbolRate');
  assertMax(metrics.staleFailureRate, thresholds.agentMaxStaleFailureRate, 'agent staleFailureRate');
}

function assertMin(value, min, label) {
  if (!isNumber(value)) {
    failures.push(`${label} is missing or non-numeric`);
    return;
  }
  if (value < min) {
    failures.push(`${label} ${value} is below ${min}`);
  }
}

function assertMax(value, max, label) {
  if (!isNumber(value)) {
    failures.push(`${label} is missing or non-numeric`);
    return;
  }
  if (value > max) {
    failures.push(`${label} ${value} exceeds ${max}`);
  }
}

function readJsonFile(filePath) {
  const raw = readTextFile(filePath);
  const json = extractFirstJsonObject(raw);
  if (!json) {
    throw new Error(`No JSON object found in ${filePath}`);
  }
  return JSON.parse(json);
}

function readTextFile(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }
  const sampleLength = Math.min(buffer.length, 200);
  let nulCount = 0;
  for (let index = 0; index < sampleLength; index++) {
    if (buffer[index] === 0) nulCount++;
  }
  if (nulCount > sampleLength / 4) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}
