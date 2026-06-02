# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via [GitHub Security Advisories](https://github.com/keweixin/code-memory/security/advisories/new).

Please include:

- Description of the vulnerability
- Steps to reproduce or proof-of-concept
- Affected versions
- Potential impact

You can expect:

- Acknowledgment within 48 hours
- An initial assessment within 7 days
- A fix or mitigation plan within 30 days for confirmed vulnerabilities

## Security Considerations

### Local-First Design

Code Memory is designed to be local-first:

- All indexed data is stored locally in `.code-memory/` within your project
- No telemetry is collected
- No code is uploaded unless you explicitly configure an embedding provider

### Embedding Providers

When you configure an embedding provider (Ollama, OpenAI), symbol chunks are sent to that provider's API for embedding generation. This is an opt-in feature. If you work with proprietary or sensitive code, consider:

- Using `--embedding none` (default) to keep all data local
- Using a local Ollama instance instead of a cloud provider
- Reviewing the chunks sent for embedding (they are symbol-level code snippets)

### API Keys

- API keys are resolved from environment variables first (`CODE_MEMORY_EMBEDDING_API_KEY`, `CODE_MEMORY_LLM_API_KEY`)
- Plaintext keys in `.code-memory/config.json` are a legacy fallback — environment variables are recommended
- Never commit `.code-memory/` to version control (it's in `.gitignore` by default)

### Supply Chain

- Run `npm run audit:official` to check for known vulnerabilities in dependencies
- CI runs this check automatically on every push
