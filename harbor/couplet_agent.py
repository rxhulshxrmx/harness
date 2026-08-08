"""Harbor agent adapter for Couplet.

Couplet (https://github.com/rxhulshxrmx/couplet) is a coding-agent VS Code
extension backed by SAP AI Core. This adapter runs its headless CLI
(dist/cli.js, built from src/cli/main.ts) inside a Harbor task container, so
Couplet can be scored on any Harbor-hosted benchmark — Terminal-Bench,
SWE-bench, and the ~75 others under harbor-framework/harbor's adapters/ — via
one agent, since Harbor's task runner is dataset-agnostic.

Requires `pip install harbor` (harbor-framework/harbor) and this file
importable (e.g. on PYTHONPATH, or run from this directory). No upstream PR
or fork is needed — harbor's AgentFactory resolves `--agent` as a plain
import path when it isn't a built-in agent name.

Credentials are never read from disk or baked into the container image; they
come from whatever env vars the job passes through to the agent (see
--agent-env below), matching the COUPLET_* variables src/cli/main.ts reads
directly — this file does not know or care that the backend is SAP AI Core,
only that main.ts needs these names set.

Example — Terminal-Bench 2.1, a single task, as a smoke test:

    harbor run \\
      --agent couplet_agent:CoupletAgent \\
      --agent-env COUPLET_CLIENT_ID=$COUPLET_CLIENT_ID \\
      --agent-env COUPLET_CLIENT_SECRET=$COUPLET_CLIENT_SECRET \\
      --agent-env COUPLET_AI_CORE_BASE_URL=$COUPLET_AI_CORE_BASE_URL \\
      --agent-env COUPLET_TOKEN_URL=$COUPLET_TOKEN_URL \\
      --agent-env COUPLET_MODEL=$COUPLET_MODEL \\
      --model $COUPLET_MODEL \\
      --dataset terminal-bench-2 \\
      --task <some-task-id>

Same command with `--dataset swebench` (see adapters/swebench in the harbor
repo for its exact name@version) runs a SWE-bench trial instead — nothing
else changes.

Before pointing a real run at this: push whatever local Couplet changes you
want scored to COUPLET_REPO_URL, then pin COUPLET_REF to that commit. A score
must be reproducible against the exact build it was measured with; a moving
branch ref defeats that. This file is unverified against a live `harbor run`
— exact flag names were confirmed by reading harbor's CLI source
(src/harbor/cli/jobs.py) and BaseInstalledAgent (src/harbor/agents/installed/
base.py) directly, not by an actual run. Treat the first invocation as a
smoke test, not a scored one.
"""

from __future__ import annotations

import shlex
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

COUPLET_REPO_URL = "https://github.com/rxhulshxrmx/couplet.git"
COUPLET_REF = "main"  # TODO: pin to a commit/tag before recording a scored run
INSTALL_DIR = "/installed-agent/couplet"

# Read directly by src/cli/main.ts — see its --help text (`node dist/cli.js --help`).
REQUIRED_ENV_VARS = (
    "COUPLET_CLIENT_ID",
    "COUPLET_CLIENT_SECRET",
    "COUPLET_AI_CORE_BASE_URL",
    "COUPLET_TOKEN_URL",
)
OPTIONAL_ENV_VARS = (
    "COUPLET_RESOURCE_GROUP",
    "COUPLET_API_VERSION",
    "COUPLET_MODEL",
    "COUPLET_DEPLOYMENT_ID",
)


class CoupletAgent(BaseInstalledAgent):
    """Installs and runs Couplet's headless CLI (dist/cli.js) as a Harbor agent."""

    @staticmethod
    @override
    def name() -> str:
        return "couplet"

    @override
    def version(self) -> str | None:
        return COUPLET_REF

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(environment, command="apt-get update && apt-get install -y git curl")
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"git clone --depth 1 --branch {shlex.quote(COUPLET_REF)} "
                f"{shlex.quote(COUPLET_REPO_URL)} {shlex.quote(INSTALL_DIR)} && "
                f"cd {shlex.quote(INSTALL_DIR)} && npm ci && npm run build && "
                "test -f dist/cli.js"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env: dict[str, str] = {}
        for name in (*REQUIRED_ENV_VARS, *OPTIONAL_ENV_VARS):
            value = self._get_env(name)
            if value is not None:
                env[name] = value

        missing = [name for name in REQUIRED_ENV_VARS if name not in env]
        if missing:
            raise ValueError(
                f"CoupletAgent is missing required env vars: {', '.join(missing)}. "
                "Pass each with --agent-env NAME=VALUE on `harbor run`."
            )

        escaped_instruction = shlex.quote(instruction)
        await self.exec_as_agent(
            environment,
            command=(
                ". $HOME/.nvm/nvm.sh; "
                f"node {shlex.quote(INSTALL_DIR)}/dist/cli.js "
                f"--instruction {escaped_instruction} "
                "--dangerously-skip-permissions "
                "2>&1 | stdbuf -oL tee /logs/agent/couplet.txt"
            ),
            env=env,
        )
