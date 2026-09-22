from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional

class OmegaConfig(BaseSettings):
    # Runtime
    OMEGA_ENV: str = "production"
    OMEGA_LOG_LEVEL: str = "INFO"
    OMEGA_TIMEZONE: str = "UTC"
    OMEGA_HITL_LEVEL: int = 5

    # Google GenAI SDK
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL_FAST: str = "gemini-2.5-flash"
    GEMINI_MODEL_DEEP: str = "gemini-2.5-pro"

    # Qdrant Vector Cloud
    QDRANT_API_KEY: str = ""
    QDRANT_CLUSTER_ID: str = ""
    QDRANT_URL: str = ""
    QDRANT_USE_LOCAL_FALLBACK: bool = True

    # Kraken Pro Execution & Staking
    KRAKEN_API_KEY: str = ""
    KRAKEN_API_SECRET: str = ""
    KRAKEN_FUTURES_KEY: str = ""
    KRAKEN_FUTURES_SECRET: str = ""
    KRAKEN_ENABLE_FIX: bool = True
    KRAKEN_STAKING_AUTO_COMPOUND: bool = True

    # Intelligence Feeds
    BYBIT_API_KEY: str = ""
    BYBIT_API_SECRET: str = ""
    ALPHAVANTAGE_API_KEY: str = ""
    GAINIUM_API_KEY: str = ""
    GAINIUM_WEBHOOK_SECRET: str = ""

    # Risk Invariants
    MAX_TOTAL_LEVERAGE: float = 5.0
    MAX_SLIPPAGE_BPS: float = 15.0
    MIN_VAULT_RESERVE_RATIO: float = 0.10
    MAX_POSITION_RISK_PCT: float = 0.02
    VIA_NEGATIVA_QUANTILE: float = 0.999
    CLUSTER_SCAN_INTERVAL_SECONDS: int = 300
    FEED_STALE_TIMEOUT_SECONDS: float = 15.0
    NETRON_PORT: int = 8082

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

config = OmegaConfig()
