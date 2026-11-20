// @ts-check
// @usersfirst/identity — House Tandem sign-in for any game or site.
// The client and the wording have no DOM; importing this module also registers the elements.
export { IdentityClient, takeRedirect, decodeToken, loginPictures } from './client.js';
export { TEXT, PROVIDER_NAMES, providerName, noticeText, summaryLines, shortDay } from './text.js';
export { UfAccountNotice } from './elements/uf-account-notice.js';
export { UfCombineAccounts } from './elements/uf-combine-accounts.js';
export { UfDeviceSignin } from './elements/uf-device-signin.js';
export { UfSignin } from './elements/uf-signin.js';
export { UfProfileCard } from './elements/uf-profile-card.js';
export { providerIcon, PROVIDER_COLORS } from './elements/icons.js';
