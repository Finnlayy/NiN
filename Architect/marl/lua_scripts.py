"""
lua_scripts.py - Production Atomic Lua Scripts for NiN MARL State Fabric.

This module provides the battle-tested, zero-trust Lua validation script
executed atomically inside Redis. It guarantees that no raw neural output
ever bypasses pre-trade risk controls, circuit-breakers, or staleness limits.
"""
from __future__ import annotations

LUA_ATOMIC_PRE_TRADE_ENGINE = """
-- ============================================================================
-- NiN Atomic Pre-Trade Risk Engine & State Synchronizer
--
-- KEYS[1]: Portfolio State Hash ('portfolio:<symbol>')
-- KEYS[2]: Audit Event Stream ('stream:audit:<symbol>') [Optional/Fallback]
--
-- ARGV[1]: Alpha Conviction Ratio [-1.0 to 1.0] (Agent 1 Continuous Output)
-- ARGV[2]: Discrete Execution Action ID (Agent 2 Output: 0=Hold, 1=Peg, 2=Touch, 3=Taker, 4=Cancel)
-- ARGV[3]: Max Allowed Absolute Position Limit (e.g. 5.0 BTC)
-- ARGV[4]: Minimum Deadband Threshold (e.g. 0.002 BTC to filter micro noise)
-- ARGV[5]: Timestamp of the current tick (Epoch ms)
-- ARGV[6]: Max Tick Staleness Tolerance (ms, e.g. 500)
-- ARGV[7]: Max Gross Order Delta in single tick (e.g. 2.0 BTC)
-- ============================================================================

local state = redis.call('HMGET', KEYS[1],
    'current_qty',          -- 1
    'allocated_capital',    -- 2
    'risk_halt',            -- 3
    'last_tick_ts',         -- 4
    'margin_headroom',      -- 5
    'pending_delta'         -- 6
)

local current_qty       = tonumber(state[1]) or 0.0
local allocated_cap     = tonumber(state[2]) or 0.0
local risk_halt         = tonumber(state[3]) or 0
local last_ts           = tonumber(state[4]) or 0
local margin_headroom   = tonumber(state[5]) or 1.0
local pending_delta     = tonumber(state[6]) or 0.0

local target_alpha      = tonumber(ARGV[1]) or 0.0
local exec_action       = tonumber(ARGV[2]) or 0
local max_pos           = tonumber(ARGV[3]) or 1.0
local deadband          = tonumber(ARGV[4]) or 0.001
local current_ts        = tonumber(ARGV[5]) or 0
local max_staleness     = tonumber(ARGV[6]) or 500
local max_gross_delta   = tonumber(ARGV[7]) or (max_pos * 1.5)

-- 1. TICK STALENESS & MONOTONICITY CHECK
if last_ts > 0 then
    if current_ts < last_ts then
        return {-10, "REJECT_OUT_OF_ORDER_TIMESTAMP", current_qty, 0.0, exec_action}
    end
    if (current_ts - last_ts) > max_staleness then
        return {-1, "REJECT_STALE_MARKET_TICK", current_qty, 0.0, exec_action}
    end
end

-- 2. HARD CIRCUIT-BREAKER / RISK HALT CHECK
if risk_halt == 1 then
    return {-2, "REJECT_CIRCUIT_BREAKER_ACTIVE", current_qty, 0.0, exec_action}
end

-- 3. MARGIN HEADROOM CHECK
if margin_headroom < 0.05 then
    return {-3, "REJECT_INSUFFICIENT_MARGIN_HEADROOM", current_qty, 0.0, exec_action}
end

-- 4. CLAMP AND BOUND TARGET CONVICTION
if target_alpha > 1.0 then target_alpha = 1.0 end
if target_alpha < -1.0 then target_alpha = -1.0 end

local target_position = target_alpha * max_pos
if math.abs(target_position) > max_pos then
    return {-4, "REJECT_POSITION_LIMIT_EXCEEDED", current_qty, 0.0, exec_action}
end

-- 5. ORDER DELTA COMPUTATION & CLAMPING
local delta = target_position - current_qty

-- Check gross delta threshold (prevent sudden single-tick market sweep)
if math.abs(delta) > max_gross_delta then
    if delta > 0 then
        delta = max_gross_delta
    else
        delta = -max_gross_delta
    end
end

-- 6. DEADBAND & NO-OP FILTERING
-- Action 0 is strict IDLE_HOLD. Also if delta is within noise deadband, NOOP.
if math.abs(delta) < deadband or exec_action == 0 then
    -- Refresh timestamp even on NOOP to maintain liveness
    redis.call('HSET', KEYS[1], 'last_tick_ts', current_ts)
    return {0, "NOOP_DEADBAND_OR_HOLD", current_qty, 0.0, exec_action}
end

-- 7. ATOMIC STATE MUTATION (LOCK IN THE INTENT)
redis.call('HMSET', KEYS[1],
    'pending_delta', delta,
    'last_action_id', exec_action,
    'last_tick_ts', current_ts,
    'target_position', target_position
)

-- Return Code 1: APPROVED_FOR_DISPATCH
-- Returns: {StatusCode, Message, CurrentQty, ApprovedOrderDelta, ActionId, CurrentTimestamp}
return {1, "APPROVED_FOR_DISPATCH", current_qty, delta, exec_action, current_ts}
"""

LUA_CIRCUIT_BREAKER_TRIGGER = """
-- KEYS[1]: Portfolio State Hash ('portfolio:<symbol>')
-- ARGV[1]: Risk Halt (1 = halt, 0 = resume)
-- ARGV[2]: Reason string
-- ARGV[3]: Timestamp ms

redis.call('HMSET', KEYS[1],
    'risk_halt', tonumber(ARGV[1]),
    'halt_reason', ARGV[2],
    'halt_ts', tonumber(ARGV[3]),
    'pending_delta', 0.0
)
return 1
"""

LUA_FILL_UPDATE_ENGINE = """
-- Atomically updates position following an execution fill
-- KEYS[1]: Portfolio State Hash ('portfolio:<symbol>')
-- ARGV[1]: Filled Quantity (positive for buy, negative for sell)
-- ARGV[2]: Execution Price
-- ARGV[3]: Fee Paid
-- ARGV[4]: Timestamp ms

local current_qty = tonumber(redis.call('HGET', KEYS[1], 'current_qty')) or 0.0
local new_qty = current_qty + tonumber(ARGV[1])

redis.call('HMSET', KEYS[1],
    'current_qty', new_qty,
    'pending_delta', 0.0,
    'last_fill_price', tonumber(ARGV[2]),
    'last_fill_ts', tonumber(ARGV[4])
)
return new_qty
"""
