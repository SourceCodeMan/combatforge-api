-- Sample unlock definitions (Phase C shape — new unlocks are INSERTs like these, never migrations).
-- payload is interpreted by the game (PFChar slot/part indices, weapon paints, etc.).
INSERT OR IGNORE INTO unlock_definitions (unlock_id, kind, criteria, payload, active, sort, created_at) VALUES
  ('title_recruit',      'title',         '{"type":"level","gte":1}',                 '{"title":"Recruit"}',                    1, 10, strftime('%s','now')),
  ('title_veteran',      'title',         '{"type":"level","gte":25}',                '{"title":"Veteran"}',                    1, 20, strftime('%s','now')),
  ('badge_builder_500',  'badge',         '{"type":"stat","stat":"tags","gte":500}',  '{"badge":"builder_gold"}',               1, 30, strftime('%s','now')),
  ('paint_rifle_desert', 'weapon_paint',  '{"type":"level","gte":5}',                 '{"weapon":"Rifle","paint":"desert"}',    1, 40, strftime('%s','now')),
  ('all_cosmetics_pack', 'cosmetic_part', '{"type":"entitlement","id":"all_access"}', '{"grant":"all_cosmetic_parts"}',         1, 50, strftime('%s','now'));
