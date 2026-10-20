from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Document(StrictModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=30000)
    scope: str = Field(default='demo-card', min_length=1, max_length=80)
    version: int = Field(default=1, ge=1)


class SourceQuote(StrictModel):
    source_id: str
    quote: str = Field(min_length=1, max_length=3000)


class Fact(SourceQuote):
    kind: Literal['rule', 'date', 'exception', 'correction', 'fact'] = 'fact'


class Compression(StrictModel):
    facts: list[Fact] = Field(default_factory=list, max_length=30)
    missing_information: list[str] = Field(default_factory=list, max_length=10)


class Decision(StrictModel):
    verdict: Literal['eligible', 'ineligible', 'insufficient']
    explanation: str = Field(min_length=1, max_length=5000)
    evidence: list[SourceQuote] = Field(default_factory=list, max_length=20)
    uncertainties: list[str] = Field(default_factory=list, max_length=10)


class Review(StrictModel):
    issues: list[str] = Field(default_factory=list, max_length=15)
    needs_original: bool = False


class Policy(StrictModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    instruction: str = Field(min_length=1, max_length=3000)
    retrieval_k: int = Field(default=4, ge=1, le=8)
    preserve_exceptions: bool = True


class TaskRequest(StrictModel):
    question: str = Field(min_length=1, max_length=4000)
    scope: str = Field(default='demo-card', min_length=1, max_length=80)
    strategy: Literal['recent', 'summary', 'retrieval', 'memory'] = 'retrieval'


class ExperimentRequest(StrictModel):
    strategies: list[Literal['recent', 'summary', 'retrieval', 'memory']] = Field(
        default_factory=lambda: ['recent', 'summary', 'retrieval'], min_length=1, max_length=4)


class MemoryCandidate(StrictModel):
    lesson: str = Field(min_length=1, max_length=2000)
    source_ids: list[str] = Field(min_length=1, max_length=10)


class Approval(StrictModel):
    evidence: str = Field(min_length=10, max_length=3000)


class Rollback(StrictModel):
    version_id: str
