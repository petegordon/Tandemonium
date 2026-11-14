-- housetandem.com Join checklist: what a Discord sign-in from the website agreed to.
-- scopes  = the Discord permissions granted, space-separated ("identify email connections guilds.join").
-- email   = Discord's verified email, kept only while "new game news" is granted.
-- Both live on the sign-in row, so merging accounts carries them and deleting the account removes them.

ALTER TABLE user_identities ADD COLUMN scopes TEXT;
ALTER TABLE user_identities ADD COLUMN email TEXT;
