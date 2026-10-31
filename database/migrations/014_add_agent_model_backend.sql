-- Records what actually answered the model calls for each investigation, so stub-backed or
-- unreachable-model runs can never be presented or counted as real-model evidence.
-- NULL = recorded before this migration (unknown backend).
ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS model_backend VARCHAR(16)
    CHECK (model_backend IN ('real', 'stub', 'unreachable', 'disabled'));
