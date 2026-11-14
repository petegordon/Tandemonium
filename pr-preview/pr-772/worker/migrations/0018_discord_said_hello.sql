-- housetandem.com Join checklist step 2, "say hello": when this Discord account was first seen
-- posting in the House Tandem server's hello channel (DISCORD_HELLO_CHANNEL_IDS). Set once.
ALTER TABLE user_identities ADD COLUMN said_hello_at INTEGER;
