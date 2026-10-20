from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / 'research' / '.env', extra='ignore')
    mode: Literal['demo', 'live'] = 'demo'
    storage: Literal['sqlite', 'postgres'] = 'sqlite'
    database_url: str = ''
    state_dir: Path = ROOT / '.research'
    llm_model: str = ''
    critic_model: str = ''
    llm_api_key: str = ''
    llm_api_base: str | None = None
    embedding_model: str = ''
    embedding_dims: int = Field(default=1536, ge=1, le=4096)
    mem0_enabled: bool = False
    langfuse_enabled: bool = False
    langfuse_public_key: str = ''
    langfuse_secret_key: str = ''
    langfuse_base_url: str = 'https://cloud.langfuse.com'
    context_budget_bytes: int = Field(default=6000, ge=512, le=64000)

    def validate_live(self):
        if self.mode == 'live' and not (self.llm_model and self.llm_api_key):
            raise ValueError('live 模式必须配置 LLM_MODEL 和 LLM_API_KEY；不会自动降级成演示')
        if self.storage == 'postgres' and not self.database_url:
            raise ValueError('PostgreSQL 模式必须配置 DATABASE_URL')
        if self.mem0_enabled and (self.mode != 'live' or self.storage != 'postgres'):
            raise ValueError('Mem0 需要 live 模式及 PostgreSQL')
        if self.mode == 'live' and self.storage == 'postgres' and not self.embedding_model:
            raise ValueError('PostgreSQL 语义检索需要 EMBEDDING_MODEL')
