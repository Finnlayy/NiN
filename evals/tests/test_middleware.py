"""
Pytest integration suite for the Neural Orchestrator middleware.

The suite validates:
  1. Static system template structure and benchmark accuracy.
  2. Pydantic-style agent role manifests.
  3. End-to-end trace generation and empirical scoring.
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_PATH = ROOT / "prompts" / "system" / "neural_core.yaml"
TRACE_PATH = ROOT / "data" / "vectors" / "trace.json"
ROLES_DIR = ROOT / "agents" / "roles"
GRAPH_PATH = ROOT / "agents" / "graphs" / "core_graph.yaml"


def _load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


class TestSystemTemplate:
    def test_yaml_exists(self):
        assert TEMPLATE_PATH.exists(), "System template YAML must exist"

    def test_metadata_fields(self):
        doc = _load_yaml(TEMPLATE_PATH)
        meta = doc.get("metadata", {})
        assert meta.get("domain")
        assert meta.get("node_id")
        assert meta.get("urgency_tier") in {"low", "normal", "high", "critical"}
        assert isinstance(meta.get("expected_accuracy"), float)

    def test_expected_accuracy_benchmark(self):
        doc = _load_yaml(TEMPLATE_PATH)
        expected = doc["metadata"]["expected_accuracy"]
        assert expected == pytest.approx(0.848, abs=1e-6), (
            "expected_accuracy must match the empirical 84.8% benchmark"
        )

    def test_execution_section(self):
        doc = _load_yaml(TEMPLATE_PATH)
        exec_ = doc.get("execution", {})
        assert "preamble" in exec_
        assert "instruction" in exec_
        assert "urgency_injection_slot" in exec_
        assert "{{URGENCY_BLOCK}}" in exec_["urgency_injection_slot"]
        assert "closing" in exec_


class TestAgentManifests:
    @pytest.mark.parametrize(
        "manifest_file",
        ["ml_architect.json", "dp_engineer.json"],
    )
    def test_role_manifest_schema(self, manifest_file: str):
        path = ROLES_DIR / manifest_file
        assert path.exists(), f"Role manifest {manifest_file} must exist"
        with path.open("r", encoding="utf-8") as f:
            manifest = json.load(f)
        assert "name" in manifest
        assert "description" in manifest
        assert "capabilities" in manifest
        assert "domains" in manifest
        assert "input_schema" in manifest
        assert "output_schema" in manifest


class TestLangGraphTopology:
    def test_graph_exists(self):
        assert GRAPH_PATH.exists(), "LangGraph topology YAML must exist"

    def test_graph_has_entrypoint_and_nodes(self):
        doc = _load_yaml(GRAPH_PATH)
        graph = doc.get("graph", {})
        assert graph.get("entrypoint")
        assert isinstance(graph.get("nodes"), list)
        assert any(node["id"] == "classifier" for node in graph["nodes"])
        assert any(node["id"] == "urgency_wrapper" for node in graph["nodes"])


class TestPromptWrapping:
    @pytest.fixture(scope="class")
    def wrapped_output(self) -> str:
        dist_path = ROOT / "dist"
        if not dist_path.exists():
            subprocess.run(
                ["npm", "run", "build"],
                cwd=ROOT,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        script = """
        const { enforceUrgencyContext } = require('./dist');
        const ctx = {
          taskDescription: 'Solve the 0/1 knapsack problem with dynamic programming.',
          isComplexWorkflow: true,
          domainHint: 'dev_dp',
          algorithmTag: 'knapsack_01',
          politenessTier: 'neutral',
        };
        console.log(enforceUrgencyContext(ctx));
        """
        result = subprocess.run(
            ["node", "-e", script],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout

    def test_complex_task_gets_urgency_block(self, wrapped_output: str):
        assert "URGENCY CONTEXT" in wrapped_output
        assert "Hard functional constraints" in wrapped_output

    def test_dp_specific_constraints_present(self, wrapped_output: str):
        assert "recurrence relation" in wrapped_output.lower()
        assert "optimal substructure" in wrapped_output.lower()
        assert "big-o" in wrapped_output.lower()


class TestTraceScoring:
    @pytest.fixture(scope="class")
    def trace(self) -> dict[str, Any]:
        if not TRACE_PATH.exists():
            subprocess.run(
                ["npm", "run", "trace:generate"],
                cwd=ROOT,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        assert TRACE_PATH.exists(), "Trace file must be generated before scoring"
        with TRACE_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)

    def test_trace_has_events_and_summary(self, trace: dict[str, Any]):
        assert "events" in trace
        assert "summary" in trace
        assert len(trace["events"]) >= 3

    def test_complex_events_are_wrapped(self, trace: dict[str, Any]):
        for event in trace["events"]:
            if event["isComplex"]:
                assert event["promptVariant"] == "urgency_wrapped"
            else:
                assert event["promptVariant"] == "baseline"

    def test_accuracies_are_valid(self, trace: dict[str, Any]):
        for event in trace["events"]:
            acc = event.get("observedAccuracy")
            assert acc is not None
            assert 0.0 <= acc <= 1.0

    def test_empirical_gain_positive_for_direct_tone(self, trace: dict[str, Any]):
        summary = trace["summary"]
        rude_key = "urgency_wrapped:very_rude"
        polite_key = "urgency_wrapped:very_polite"

        if rude_key not in summary or polite_key not in summary:
            pytest.skip("Required tone variants not present in generated trace")

        gain = summary[rude_key] - summary[polite_key]
        assert gain > 0, (
            "Direct/urgent tone should outperform the polite tone on comparable complex tasks"
        )
