# Thyme SDK & CLI

A clean, modern toolkit for building and deploying Web3 automation tasks.

## Packages

- **[@thyme-labs/sdk](./packages/sdk)** - SDK for authoring Web3 tasks
- **[@thyme-labs/cli](./packages/cli)** - CLI for local development and deployment

## Quick Start

```bash
# Install CLI globally
npm install -g @thyme-labs/cli

# Create new project
thyme init my-project

# Create a task
cd my-project
thyme new my-task

# Run locally
thyme run my-task

# Simulate on-chain
thyme run my-task --simulate

# Authenticate, then upload your code to the cloud
thyme login
thyme upload my-task
```

After `thyme upload`, your code appears in **Console → Functions**. Upload only puts the
code in the cloud — it does not schedule anything. Triggers, profile, gas mode, args, and
secret bindings are configured in the Thyme Console when you assemble an executable from
the uploaded function.

## Development

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun run test

# Format code
bun run format
```

## License

MIT
