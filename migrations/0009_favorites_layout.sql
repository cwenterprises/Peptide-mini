-- Favorite vendors star + user-arranged dashboard card order
ALTER TABLE vendors ADD COLUMN favorite INTEGER DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN dash_order TEXT;
