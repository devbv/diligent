"""Harbor agent adapter for diligent coding agent."""

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class DiligentAgent(BaseInstalledAgent):

    @staticmethod
    def name() -> str:
        return "diligent"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "templates" / "install.sh.j2"

    async def setup(self, **kwargs) -> None:
        # Copy pre-built binary to logs_dir (mounted as /logs/agent/ in container)
        binary_path = self._resolve_binary_path()
        dest = self.logs_dir / "diligent-linux-x64"
        shutil.copy2(binary_path, dest)
        await super().setup(**kwargs)

    def _resolve_binary_path(self) -> Path:
        """Find the diligent-linux-x64 binary.

        Resolution order:
        1. DILIGENT_BINARY_PATH env var (explicit path)
        2. dist/diligent-linux-x64 relative to git repo root
        """
        env_path = os.environ.get("DILIGENT_BINARY_PATH")
        if env_path:
            p = Path(env_path)
            if p.exists():
                return p
            raise FileNotFoundError(f"DILIGENT_BINARY_PATH={env_path} does not exist")

        # Auto-detect from git repo root
        try:
            repo_root = subprocess.check_output(
                ["git", "rev-parse", "--show-toplevel"],
                text=True,
            ).strip()
            candidate = Path(repo_root) / "dist" / "diligent-linux-x64"
            if candidate.exists():
                return candidate
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass

        raise FileNotFoundError(
            "Cannot find diligent-linux-x64 binary. "
            "Either set DILIGENT_BINARY_PATH or run 'bun run build:linux-x64' first."
        )

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        escaped = shlex.quote(instruction)

        env: dict[str, str] = {}

        # Forward API keys
        for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
            if key in os.environ:
                env[key] = os.environ[key]

        # Forward model selection via DILIGENT_MODEL env var
        if self.model_name:
            # Harbor uses "provider/model" format, diligent wants just the model ID
            model_id = self.model_name
            if "/" in model_id:
                model_id = model_id.split("/", 1)[1]
            env["DILIGENT_MODEL"] = model_id

        # Extra env from constructor
        env.update(self._extra_env)

        output_dir = EnvironmentPaths.agent_dir

        return [
            ExecInput(
                command=f"/installed-agent/diligent --prompt {escaped}",
                env=env,
                timeout_sec=600,
            ),
            # Copy session logs to mounted dir for host-side access
            # Sessions land in {cwd}/.diligent/sessions/ — use find to catch any location
            ExecInput(
                command=f"mkdir -p {output_dir}/sessions && find / -path '*/.diligent/sessions/*.jsonl' -exec cp {{}} {output_dir}/sessions/ \\; 2>/dev/null; true",
                timeout_sec=30,
            ),
        ]

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse diligent session JSONL to extract token usage."""
        sessions_dir = self.logs_dir / "sessions"
        if not sessions_dir.exists():
            return

        total_input = 0
        total_output = 0
        total_cache = 0

        for jsonl_file in sessions_dir.glob("*.jsonl"):
            with open(jsonl_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if entry.get("type") != "message":
                        continue
                    msg = entry.get("message", {})
                    if msg.get("role") != "assistant":
                        continue

                    usage = msg.get("usage", {})
                    total_input += usage.get("inputTokens", 0)
                    total_output += usage.get("outputTokens", 0)
                    total_cache += usage.get("cacheReadTokens", 0)
                    total_cache += usage.get("cacheWriteTokens", 0)

        context.n_input_tokens = total_input
        context.n_output_tokens = total_output
        context.n_cache_tokens = total_cache if total_cache > 0 else None
