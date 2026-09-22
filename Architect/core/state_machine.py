from enum import Enum, auto

class SystemExecutionState(Enum):
    PLANNING = auto()
    DISPATCHED = auto()
    RUNNING = auto()
    REFLECTING = auto()
    COMPLETE = auto()

class TrancheLifecycleState(Enum):
    T1 = auto()
    T2 = auto()
    T3 = auto()
    FREE_ROLL = auto()

class FeedConnectionState(Enum):
    CONNECTED_LIVE = auto()
    STALE_CACHE_DEGRADED = auto()

class MarketRegimeState(Enum):
    DECOUPLED_META = auto()
    BTC_SATELLITE = auto()
    ETH_EVM_SATELLITE = auto()
    CHOP_REACTIVE_NOISE = auto()
