import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Agent SDK spawns the bundled Claude Code CLI from its package
  // directory; keep both SDKs unbundled so those paths survive.
  serverExternalPackages: [
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/sdk",
    "@resvg/resvg-js",
  ],
};

export default nextConfig;
