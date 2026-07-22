# @summary Harbor 0.20 installed-agent adapter for the Diligent coding agent

"""Run a packaged Diligent binary in Harbor task environments."""

from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path
from typing import ClassVar, override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class DiligentAgent(BaseInstalledAgent):
    """Harbor adapter that uploads and runs the Linux x64 Diligent binary."""

    _BINARY_TARGET: ClassVar[str] = "/installed-agent/diligent"
    _AUTH_UPLOAD_TARGET: ClassVar[str] = "/tmp/diligent-harbor-auth.jsonc"
    _PROVIDER_API_KEY_ENVS: ClassVar[dict[str, str]] = {
        "anthropic": "ANTHROPIC_API_KEY",
        "gemini": "GEMINI_API_KEY",
        "openai": "OPENAI_API_KEY",
        "zai-coding-plan": "ZAI_API_KEY",
    }

    @staticmethod
    def name() -> str:
        return "diligent"

    def get_version_command(self) -> str:
        return f"{self._BINARY_TARGET} --version"

    def parse_version(self, stdout: str) -> str:
        version = stdout.strip()
        return version.removeprefix("diligent").strip() or version

    def _resolve_binary_path(self) -> Path:
        """Resolve an explicit binary or the repository's standard build output."""
        env_path = self._get_env("DILIGENT_BINARY_PATH")
        if env_path:
            binary = Path(env_path).expanduser()
            if binary.is_file():
                return binary.resolve()
            raise FileNotFoundError(
                f"DILIGENT_BINARY_PATH={env_path} does not point to a file"
            )

        try:
            repo_root = subprocess.check_output(
                ["git", "rev-parse", "--show-toplevel"],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
        except (subprocess.CalledProcessError, FileNotFoundError):
            repo_root = ""

        if repo_root:
            candidate = Path(repo_root) / "dist" / "diligent-linux-x64"
            if candidate.is_file():
                return candidate.resolve()

        raise FileNotFoundError(
            "Cannot find diligent-linux-x64. Set DILIGENT_BINARY_PATH or run "
            "'bun run build:linux-x64' from the repository root."
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        binary_path = self._resolve_binary_path()
        await environment.upload_file(binary_path, self._BINARY_TARGET)
        await self.exec_as_root(
            environment,
            command=f"chmod 755 {self._BINARY_TARGET}",
        )
        await self.exec_as_root(
            environment,
            command=(
                "if ! command -v rg >/dev/null 2>&1; then"
                "  if command -v apk >/dev/null 2>&1; then"
                "    apk add --no-cache ripgrep;"
                "  elif command -v apt-get >/dev/null 2>&1; then"
                "    apt-get update && apt-get install -y ripgrep;"
                "  elif command -v yum >/dev/null 2>&1; then"
                "    yum install -y ripgrep;"
                "  else"
                '    echo "No supported package manager found for ripgrep" >&2; exit 1;'
                "  fi;"
                " fi;"
                " command -v rg >/dev/null 2>&1"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=self.get_version_command(),
        )

    def _resolve_model(self) -> tuple[str, str]:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "Diligent's Harbor adapter requires a provider/model value, "
                "for example anthropic/claude-sonnet-4-6."
            )
        provider, model_id = self.model_name.split("/", 1)
        if not provider or not model_id:
            raise ValueError(
                "Diligent's Harbor adapter requires a non-empty provider/model value."
            )
        return provider, model_id

    def _resolve_auth(self, provider: str) -> tuple[Path | None, dict[str, str]]:
        auth_path = self._get_env("DILIGENT_AUTH_JSON_PATH")
        if auth_path:
            path = Path(auth_path).expanduser()
            if not path.is_file():
                raise ValueError(
                    "DILIGENT_AUTH_JSON_PATH does not point to a readable file: "
                    f"{auth_path}"
                )
            return path.resolve(), {}

        env_name = self._PROVIDER_API_KEY_ENVS.get(provider)
        if env_name is None:
            supported = ", ".join(sorted(self._PROVIDER_API_KEY_ENVS))
            raise ValueError(
                f"Provider '{provider}' needs DILIGENT_AUTH_JSON_PATH. "
                f"Direct API-key injection supports: {supported}."
            )
        api_key = self._get_env(env_name)
        if not api_key:
            raise ValueError(
                f"Provider '{provider}' requires {env_name} or "
                "DILIGENT_AUTH_JSON_PATH."
            )
        return None, {env_name: api_key}

    def _build_mcp_config(self) -> dict[str, object]:
        servers: dict[str, object] = {}
        for server in self.mcp_servers:
            if server.transport == "stdio":
                servers[server.name] = {
                    "command": server.command,
                    "args": server.args,
                }
            else:
                servers[server.name] = {
                    "type": "sse"
                    if server.transport == "sse"
                    else "http",
                    "url": server.url,
                }
        return servers

    def _build_config_command(
        self,
        provider: str,
        model_id: str,
        auth_file: Path | None,
    ) -> str:
        config: dict[str, object] = {
            "model": {"provider": provider, "modelId": model_id},
            "provider": {"auth": {"credentialsStore": "file"}},
        }
        if self.skills_dir:
            config["skills"] = {"enabled": True, "paths": [self.skills_dir]}
        if self.mcp_servers:
            config["mcpServers"] = self._build_mcp_config()

        config_json = shlex.quote(json.dumps(config))
        commands = [
            "mkdir -p ~/.diligent",
            f"printf '%s\\n' {config_json} > ~/.diligent/config.jsonc",
        ]

        if auth_file is not None:
            commands.append(
                f"install -m 600 {self._AUTH_UPLOAD_TARGET} ~/.diligent/auth.jsonc"
            )
        else:
            env_name = self._PROVIDER_API_KEY_ENVS[provider]
            auth_json = shlex.quote(json.dumps({provider: f"{{env:{env_name}}}"}))
            commands.extend(
                [
                    f"printf '%s\\n' {auth_json} > ~/.diligent/auth.jsonc",
                    "chmod 600 ~/.diligent/auth.jsonc",
                ]
            )

        return " && ".join(commands)

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider, model_id = self._resolve_model()
        auth_file, provider_env = self._resolve_auth(provider)
        if auth_file is not None:
            await environment.upload_file(auth_file, self._AUTH_UPLOAD_TARGET)

        setup_command = self._build_config_command(provider, model_id, auth_file)
        escaped_instruction = shlex.quote(instruction)
        output_dir = EnvironmentPaths.agent_dir

        with environment.scoped_exec_env(provider_env):
            await self.exec_as_agent(
                environment,
                command=setup_command,
                timeout_sec=30,
            )
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"{self._BINARY_TARGET} --yolo --prompt "
                        f"{escaped_instruction} 2>&1 | tee {output_dir}/diligent.log"
                    ),
                )
            finally:
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"mkdir -p {output_dir}/sessions && "
                        "if [ -d ~/.diligent/sessions ]; then "
                        "find ~/.diligent/sessions -maxdepth 1 -type f -name '*.jsonl' "
                        f"-exec cp {{}} {output_dir}/sessions/ \\;; fi"
                    ),
                    timeout_sec=30,
                )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Aggregate token usage from Diligent's synced session JSONL files."""
        sessions_dir = self.logs_dir / "sessions"
        if not sessions_dir.exists():
            return

        total_input = 0
        total_output = 0
        total_cache = 0

        for jsonl_file in sessions_dir.glob("*.jsonl"):
            with jsonl_file.open(encoding="utf-8") as session_file:
                for line in session_file:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("type") != "message":
                        continue
                    message = entry.get("message", {})
                    if message.get("role") != "assistant":
                        continue
                    usage = message.get("usage", {})
                    total_input += usage.get("inputTokens", 0)
                    total_output += usage.get("outputTokens", 0)
                    total_cache += usage.get("cacheReadTokens", 0)
                    total_cache += usage.get("cacheWriteTokens", 0)

        context.n_input_tokens = total_input
        context.n_output_tokens = total_output
        context.n_cache_tokens = total_cache or None
