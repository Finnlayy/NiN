"""
Pytest suite for the continuous-learning subsystem.

Validates:
  1. JSON Schema data schemes for outcomes, feedback, knowledge, skills,
     error patterns, tasks, schedules and risk guards.
  2. Generated learning telemetry trace.
  3. The growth signals: skill profiling, error memory, Knowledge Base
     research, learning schedules and pre-execution risk guards.
"""

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS_DIR = ROOT / "schemas" / "learning"
LEARNING_TRACE_PATH = ROOT / "data" / "vectors" / "learning_trace.json"


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


SCHEMA_CASES = [
    ("outcome.schema.json", "LearningOutcome"),
    ("feedback.schema.json", "LearningFeedback"),
    ("knowledge_entry.schema.json", "KnowledgeEntry"),
    ("skill.schema.json", "Skill"),
    ("error_pattern.schema.json", "ErrorPattern"),
    ("learning_task.schema.json", "LearningTask"),
    ("schedule.schema.json", "LearningSchedule"),
    ("risk_guard.schema.json", "RiskGuard"),
]


class TestLearningSchemas:
    @pytest.mark.parametrize("filename,title", SCHEMA_CASES)
    def test_schema_json_is_valid(self, filename: str, title: str):
        path = SCHEMAS_DIR / filename
        assert path.exists(), f"Schema {filename} must exist"
        schema = _load_json(path)
        assert schema.get("$schema")
        assert schema.get("title") == title
        assert schema.get("type") == "object"
        assert schema.get("required")

    def test_outcome_schema_has_learning_signals(self):
        schema = _load_json(SCHEMAS_DIR / "outcome.schema.json")
        props = schema["properties"]
        assert "signature" in props
        assert "success" in props
        assert "errorClass" in props
        assert "appliedPolicies" in props

    def test_schedule_schema_has_periodic_learning_steps(self):
        schema = _load_json(SCHEMAS_DIR / "schedule.schema.json")
        props = schema["properties"]
        assert "cadenceMs" in props
        assert "nextRunAt" in props
        assert "steps" in props

    def test_skill_schema_has_spaced_repetition_fields(self):
        schema = _load_json(SCHEMAS_DIR / "skill.schema.json")
        props = schema["properties"]
        assert "proficiency" in props
        assert "confidence" in props
        assert "intervalDays" in props
        assert "easeFactor" in props
        assert "errorFingerprints" in props
        assert "antiPatterns" in props


class TestLearningTrace:
    @pytest.fixture(scope="class")
    def trace(self) -> dict[str, Any]:
        subprocess.run(
            ["npm", "run", "learning:trace:generate"],
            cwd=ROOT,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert LEARNING_TRACE_PATH.exists(), "Learning trace must exist after generation"
        return _load_json(LEARNING_TRACE_PATH)

    def test_trace_has_growth_artifacts(self, trace: dict[str, Any]):
        assert "state" in trace
        assert "research" in trace
        assert "guard" in trace
        assert "scheduleRun" in trace
        assert "dataEvaluation" in trace

    def test_failure_is_retained_as_knowledge(self, trace: dict[str, Any]):
        bad_feedback = trace["badFeedback"]
        assert bad_feedback["knowledgeEntry"] is not None
        body = bad_feedback["knowledgeEntry"]["body"]
        assert "gradient-boosted" in body.lower() or "interaction" in body.lower()
        assert bad_feedback["newErrorPatternIds"]

    def test_error_is_promoted_to_skill_antipattern(self, trace: dict[str, Any]):
        skills = trace["state"]["skills"]
        xgboost = next(s for s in skills if s["domain"] == "ml_30core" and s["algorithmTag"] == "xgboost")
        assert xgboost["errors"] >= 1
        assert xgboost["antiPatterns"]

    def test_weak_skill_produces_remediation_task(self, trace: dict[str, Any]):
        open_tasks = trace["state"]["openTasks"]
        assert any(task["type"] == "remediation" for task in open_tasks)
        assert any(task["type"] == "research" for task in open_tasks)

    def test_repeated_error_guard_has_known_risk(self, trace: dict[str, Any]):
        guard = trace["guard"]
        assert guard["hasKnownPattern"] is True
        assert guard["risk"] > 0
        assert guard["recommendation"]

    def test_knowledge_base_research_finds_prior_solution(self, trace: dict[str, Any]):
        research = trace["research"]
        assert len(research) >= 1
        assert "correction" in {item["entry"]["contentType"] for item in research}

    def test_data_evaluation_is_bounded(self, trace: dict[str, Any]):
        evaluation = trace["dataEvaluation"]
        assert 0.0 <= evaluation["dataScore"] <= 1.0
        assert 0.0 <= evaluation["completenessScore"] <= 1.0
        assert 0.0 <= evaluation["anomalyScore"] <= 1.0

    def test_schedule_creates_tasks(self, trace: dict[str, Any]):
        schedule_run = trace["scheduleRun"]
        assert schedule_run["schedulesRunCount"] >= 1
        assert schedule_run["createdTaskIds"]

    def test_define_eval_pipeline_is_present_in_trace(self, trace: dict[str, Any]):
        # Die strukturierte Evaluierungs-Pipeline (`defineEval`) ersetzt statische Scores.
        assert "defineEvalPipeline" in trace
        pipeline = trace["defineEvalPipeline"]
        assert pipeline["name"] == "NIO-Learning-Quality-Pipeline"
        assert pipeline["threshold"] == 85
        assert isinstance(pipeline["totalScore"], int)
        assert 0 <= pipeline["totalScore"] <= 100
        assert "metrics" in pipeline
        assert "correctness" in pipeline["metrics"]
        assert "feedback_alignment" in pipeline["metrics"]
        assert "policy_safety" in pipeline["metrics"]
        assert pipeline["rlhfContextUsed"] >= 1
