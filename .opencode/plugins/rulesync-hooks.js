export const RulesyncHooksPlugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await $`pnpm run lint 2>&1 | tail -30`;
        await $`node "$(git rev-parse --show-toplevel)/scripts/check-pr-preflight.mjs" --advisory`;
      }
    },
    "tool.execute.before": async (input) => {
      {
        const __re = new RegExp("Bash");
        if (__re.test(input.tool)) {
          await $`D="\${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"; node "$D/scripts/block-agent-github-review-writes.mjs" || exit 2`;
        }
      }
    },
  };
};
