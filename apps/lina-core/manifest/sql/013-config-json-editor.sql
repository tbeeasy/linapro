-- ------------------------------------------------------------
-- 013: Config JSON Editor
-- 013：参数设置 JSON 编辑器
-- Purpose: Documents the json value type on sys_config.value_type; no schema or data change.
-- 用途：在 sys_config.value_type 列注释中补充 json 值类型；不改表结构与数据。
-- ------------------------------------------------------------

COMMENT ON COLUMN sys_config."value_type" IS 'Parameter value input type: text, textarea, number, boolean, select, radio, multi_select, richtext, json';
