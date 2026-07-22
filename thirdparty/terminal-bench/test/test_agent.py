# @summary Contract tests for the Harbor 0.20 Diligent installed-agent adapter

import asyncio
import json
import subprocess
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from diligent_tbench import DiligentAgent


class FakeEnvironment:
    def __init__(self) -> None:
        self.default_user = None
        self.commands: list[dict[str, object]] = []
        self.uploads: list[tuple[bytes, str]] = []
        self.scoped_envs: list[dict[str, str]] = []

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((Path(source_path).read_bytes(), target_path))

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> SimpleNamespace:
        self.commands.append(
            {
                "command": command,
                "cwd": cwd,
                "env": env,
                "timeout_sec": timeout_sec,
                "user": user,
            }
        )
        if "diligent --version" in command:
            return SimpleNamespace(return_code=0, stdout="diligent 0.1.0\n", stderr="")
        return SimpleNamespace(return_code=0, stdout="", stderr="")

    @contextmanager
    def scoped_exec_env(self, env: dict[str, str]):
        self.scoped_envs.append(dict(env))
        yield


def create_agent(tmp_path: Path, model_name: str = "anthropic/claude-sonnet-test") -> DiligentAgent:
    return DiligentAgent(logs_dir=tmp_path / "logs", model_name=model_name)


def test_install_uploads_binary_and_uses_harbor_environment_api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    binary = tmp_path / "diligent-linux-x64"
    binary.write_bytes(b"diligent-binary")
    monkeypatch.setenv("DILIGENT_BINARY_PATH", str(binary))
    environment = FakeEnvironment()
    agent = create_agent(tmp_path)

    asyncio.run(agent.install(environment))

    assert environment.uploads == [(b"diligent-binary", "/installed-agent/diligent")]
    commands = [str(call["command"]) for call in environment.commands]
    assert any("chmod 755 /installed-agent/diligent" in command for command in commands)
    assert any("command -v rg" in command for command in commands)
    assert any("/installed-agent/diligent --version" in command for command in commands)


def test_run_writes_provider_scoped_config_without_logging_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = "anthropic-secret-value"
    monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
    environment = FakeEnvironment()
    agent = create_agent(tmp_path)

    asyncio.run(agent.run("Fix the failing test.", environment, SimpleNamespace()))

    commands = [str(call["command"]) for call in environment.commands]
    combined = "\n".join(commands)
    assert '"provider": "anthropic"' in combined
    assert '"modelId": "claude-sonnet-test"' in combined
    assert "{env:ANTHROPIC_API_KEY}" in combined
    assert secret not in combined
    assert "--yolo --prompt" in combined
    assert environment.scoped_envs == [{"ANTHROPIC_API_KEY": secret}]
    for command in commands:
        subprocess.run(["bash", "-n", "-c", command], check=True)


def test_run_rejects_missing_provider_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    environment = FakeEnvironment()
    agent = create_agent(tmp_path, model_name="openai/gpt-test")

    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        asyncio.run(agent.run("Fix the failing test.", environment, SimpleNamespace()))

    assert environment.commands == []


def test_run_uploads_preconfigured_auth_without_logging_its_contents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = "oauth-secret-value"
    auth_file = tmp_path / "auth.jsonc"
    auth_file.write_text(json.dumps({"chatgpt": secret}), encoding="utf-8")
    monkeypatch.setenv("DILIGENT_AUTH_JSON_PATH", str(auth_file))
    environment = FakeEnvironment()
    agent = create_agent(tmp_path, model_name="chatgpt/gpt-test")

    asyncio.run(agent.run("Fix the failing test.", environment, SimpleNamespace()))

    assert environment.uploads == [
        (auth_file.read_bytes(), "/tmp/diligent-harbor-auth.jsonc")
    ]
    commands = "\n".join(str(call["command"]) for call in environment.commands)
    assert "install -m 600 /tmp/diligent-harbor-auth.jsonc" in commands
    assert secret not in commands


def test_run_rejects_unscoped_model_name(tmp_path: Path) -> None:
    environment = FakeEnvironment()
    agent = create_agent(tmp_path, model_name="claude-sonnet-test")

    with pytest.raises(ValueError, match="provider/model"):
        asyncio.run(agent.run("Fix the failing test.", environment, SimpleNamespace()))


def test_populate_context_sums_usage_from_session_logs(tmp_path: Path) -> None:
    agent = create_agent(tmp_path)
    sessions_dir = agent.logs_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    entries = [
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "usage": {
                    "inputTokens": 11,
                    "outputTokens": 7,
                    "cacheReadTokens": 5,
                    "cacheWriteTokens": 3,
                },
            },
        },
        {"type": "message", "message": {"role": "user", "usage": {"inputTokens": 100}}},
    ]
    (sessions_dir / "session.jsonl").write_text(
        "\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8"
    )
    context = SimpleNamespace(n_input_tokens=0, n_output_tokens=0, n_cache_tokens=None)

    agent.populate_context_post_run(context)

    assert context.n_input_tokens == 11
    assert context.n_output_tokens == 7
    assert context.n_cache_tokens == 8
