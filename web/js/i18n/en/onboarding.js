export default {
  "ob.title": "Get started",
  "ob.help":
    "Three steps to your first agent: build the base template, create a box, then connect an agent to MiniBox. This card leaves once you have a box.",
  "ob.dismiss": "Hide",
  "ob.done": "Done",
  "ob.now": "Next",
  "ob.locked": "This step opens once the steps above it are done.",
  "ob.step.template": "Build the base template",
  "ob.step.box": "Create your first box",
  "ob.step.agent": "Connect an agent",
  "ob.templateUnknown": "Reading the templates on this host…",
  "ob.templateBuilt": "{ref} is on this host, so new boxes have an image to start from.",
  "ob.templateMissing":
    "No host holds the base template yet. Building it downloads images and takes about 1–3 minutes; the build log opens in the Tasks panel.",
  "ob.templateAction": "Build base template",
  "ob.buildStarted": "Building base template",
  "ob.boxText":
    "A box is a container with its own filesystem, a persistent workspace and its own processes. Give it a name, keep the defaults, and MiniBox starts it.",
  "ob.boxAction": "Create a box",
  "ob.agentText":
    "An agent works inside a box through the MiniBox MCP server at /mcp, with an agent token. Pick the client you use, choose what the token may do, and paste the configuration it gives you.",
  "ob.agentClient": "Client",
  "ob.client.claudeCode": "Claude Code",
  "ob.client.codex": "Codex",
  "ob.client.other": "Other clients",
  "ob.agentPreset": "Token preset",
  "ob.agentPresetHelp":
    "The preset decides what the agent may do. Sandboxed agent can run commands and change files, but cannot attach volumes, install tools or open SSH.",
  "ob.agentAction": "Create token and show configuration",
  "ob.agentBoxNote":
    "The token is scoped to boxes it creates itself, so the agent creates its own box on its first call. Settings lists the token under Agent API tokens.",
  "ob.agentSecret": "Token secret",
  "ob.agentSecretOnce":
    "Copy it now: this is the only time MiniBox shows it. If you lose it, revoke the token and create another.",
  "ob.agentSnippet": "Paste this into {client}",
  "ob.agentSnippetWhere": "In {path}. The token is inside it, so keep the file out of version control.",
  "ob.agentCopy": "Copy configuration",
  "ob.agentCopySecret": "Copy token only",
  "ob.agentCopied": "Configuration copied. Paste it into {client}, then restart the client.",
  "ob.agentCopiedSecret": "Token copied.",
  "ob.agentDone": "Done, hide this",
};
