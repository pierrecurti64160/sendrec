ALTER TABLE organizations ADD COLUMN plan_inherited_from UUID REFERENCES users(id);
