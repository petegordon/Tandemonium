// @ts-check
// @usersfirst/identity — House Tandem sign-in for any game or site.
// The client and the wording have no DOM; importing this module also registers the elements.
import { setDefaultConfirm } from './client.js';
import { askInPage } from './elements/ask-switch.js';
export { IdentityClient, takeRedirect, decodeToken, loginPictures, setDefaultConfirm } from './client.js';
export { askInPage, askMarkup } from './elements/ask-switch.js';
export { TEXT, PROVIDER_NAMES, providerName, noticeText, summaryLines, shortDay } from './text.js';
export { UfAccountNotice } from './elements/uf-account-notice.js';
export { UfCombineAccounts } from './elements/uf-combine-accounts.js';
export { UfDeviceSignin } from './elements/uf-device-signin.js';
export { UfSignin } from './elements/uf-signin.js';
export { UfProfileCard } from './elements/uf-profile-card.js';
export { providerIcon, PROVIDER_COLORS } from './elements/icons.js';

// With the elements loaded, the switch question is asked on the page (see ask-switch.js).
setDefaultConfirm(askInPage);
